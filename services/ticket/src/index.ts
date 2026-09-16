import express from 'express';
import mysql from 'mysql2/promise';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { randomBytes } from 'node:crypto';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

const SERVICE = 'ticket';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3005);
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? '';
const CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? '';
const ORDER_EVENTS_QUEUE_URL = process.env.ORDER_EVENTS_QUEUE_URL ?? '';
const verifier = USER_POOL_ID && CLIENT_ID
  ? CognitoJwtVerifier.create({ userPoolId: USER_POOL_ID, clientId: CLIENT_ID, tokenUse: 'access' })
  : null;
const databaseConfigured = Boolean(process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER && process.env.DB_PASSWORD);
const database = mysql.createPool({
  host: process.env.DB_HOST ?? '',
  port: Number(process.env.DB_PORT ?? 3306),
  database: process.env.DB_NAME ?? '',
  user: process.env.DB_USER ?? '',
  password: process.env.DB_PASSWORD ?? '',
  connectionLimit: 8,
  ...(process.env.DB_SSL === 'false' ? {} : { ssl: { rejectUnauthorized: false } }),
});
const sqs = new SQSClient({});

const app = express();
app.disable('x-powered-by');
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: SERVICE });
});

type Outcome = 'VALID' | 'ALREADY_USED' | 'INVALID' | 'WRONG_EVENT';

interface Caller {
  readonly sub: string;
}

interface CheckinInput {
  readonly eventId?: unknown;
  readonly ticketId?: unknown;
  readonly qrToken?: unknown;
}

interface OrderPaidItem {
  readonly orderItemId: number;
  readonly seatId: number | null;
  readonly quantity: number;
}

interface OrderPaidEvent {
  readonly type: 'OrderPaid';
  readonly version: 1;
  readonly orderId: number;
  readonly eventId: number;
  readonly customerSub: string;
  readonly customerEmail: string;
  readonly items: readonly OrderPaidItem[];
}

async function authenticate(req: express.Request): Promise<Caller | null> {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !verifier) return null;
  try {
    const claims = await verifier.verify(token);
    return { sub: String(claims.sub) };
  } catch {
    return null;
  }
}

async function requireEventAccess(sub: string, eventId: number): Promise<boolean> {
  const [rows] = await database.query<mysql.RowDataPacket[]>(
    "SELECT membership_id FROM event_inventory.event_team_memberships WHERE event_id = ? AND user_sub = ? AND role IN ('HELPER', 'ORGANISER') AND invite_status = 'ACCEPTED' LIMIT 1",
    [eventId, sub],
  );
  return rows.length > 0;
}

function parseEventId(value: unknown): number | null {
  const eventId = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isSafeInteger(eventId) && eventId > 0 ? eventId : null;
}

function parseTicketId(value: unknown): number | null {
  const ticketId = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isSafeInteger(ticketId) && ticketId > 0 ? ticketId : null;
}

function parseToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  return token.length > 0 && token.length <= 255 ? token : null;
}

export function parseOrderPaid(value: unknown): OrderPaidEvent | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  const orderId = parseTicketId(event['orderId']);
  const eventId = parseEventId(event['eventId']);
  const customerSub = typeof event['customerSub'] === 'string' ? event['customerSub'].trim() : '';
  const customerEmail = typeof event['customerEmail'] === 'string' ? event['customerEmail'].trim() : '';
  if (event['type'] !== 'OrderPaid' || event['version'] !== 1 || !orderId || !eventId ||
      !customerSub || customerSub.length > 36 || !customerEmail || customerEmail.length > 255 ||
      !Array.isArray(event['items']) || event['items'].length === 0) return null;

  const items: OrderPaidItem[] = [];
  for (const raw of event['items']) {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    const orderItemId = parseTicketId(item['order_item_id']);
    const quantity = parseTicketId(item['quantity']);
    const seatId = item['seat_id'] === null ? null : parseTicketId(item['seat_id']);
    if (!orderItemId || !quantity || quantity > 50 || (item['seat_id'] !== null && !seatId) || (seatId && quantity !== 1)) {
      return null;
    }
    items.push({ orderItemId, seatId, quantity });
  }
  return { type: 'OrderPaid', version: 1, orderId, eventId, customerSub, customerEmail, items };
}

async function issueTickets(event: OrderPaidEvent): Promise<number> {
  const connection = await database.getConnection();
  const lockName = `ticket-order-${event.orderId}`;
  let lockAcquired = false;
  try {
    const [locks] = await connection.query<mysql.RowDataPacket[]>('SELECT GET_LOCK(?, 10) AS acquired', [lockName]);
    lockAcquired = Number(locks[0]?.acquired) === 1;
    if (!lockAcquired) throw new Error('ticket_order_lock_timeout');
    await connection.beginTransaction();
    const [existing] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT order_item_id FROM tickets WHERE order_id = ? FOR UPDATE',
      [event.orderId],
    );
    const issuedByItem = new Map<number, number>();
    for (const row of existing) {
      const orderItemId = Number(row.order_item_id);
      issuedByItem.set(orderItemId, (issuedByItem.get(orderItemId) ?? 0) + 1);
    }
    let issued = 0;
    for (const item of event.items) {
      const missing = Math.max(0, item.quantity - (issuedByItem.get(item.orderItemId) ?? 0));
      for (let index = 0; index < missing; index += 1) {
        await connection.execute(
          `INSERT INTO tickets
            (order_id, order_item_id, event_id, customer_sub, customer_email, seat_id, qr_token)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [event.orderId, item.orderItemId, event.eventId, event.customerSub, event.customerEmail,
            item.seatId, randomBytes(32).toString('base64url')],
        );
        issued += 1;
      }
    }
    await connection.commit();
    return issued;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    if (lockAcquired) {
      try {
        await connection.query('SELECT RELEASE_LOCK(?)', [lockName]);
      } catch (error) {
        console.error('ticket order lock release failed', { orderId: event.orderId, error });
      }
    }
    connection.release();
  }
}

async function consumeOrderPaidEvents(): Promise<void> {
  if (!ORDER_EVENTS_QUEUE_URL || !databaseConfigured) return;
  for (;;) {
    try {
      const result = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: ORDER_EVENTS_QUEUE_URL,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20,
        VisibilityTimeout: 60,
      }));
      for (const message of result.Messages ?? []) {
        if (!message.ReceiptHandle) continue;
        let event: OrderPaidEvent | null = null;
        try {
          event = parseOrderPaid(message.Body ? JSON.parse(message.Body) : null);
        } catch {
          event = null;
        }
        if (event) await issueTickets(event);
        else console.error('discarding invalid OrderPaid message', { messageId: message.MessageId });
        await sqs.send(new DeleteMessageCommand({
          QueueUrl: ORDER_EVENTS_QUEUE_URL,
          ReceiptHandle: message.ReceiptHandle,
        }));
      }
    } catch (error) {
      console.error('order event consumption failed', error);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

async function requireConfigured(res: express.Response): Promise<boolean> {
  if (!databaseConfigured) {
    res.status(503).json({ error: 'database_not_configured' });
    return false;
  }
  return true;
}

async function requireCaller(req: express.Request, res: express.Response): Promise<Caller | null> {
  const caller = await authenticate(req);
  if (!caller) res.status(401).json({ error: 'unauthenticated' });
  return caller;
}

export function checkinInput(body: CheckinInput): { eventId: number; ticketId: number | null; qrToken: string | null } | null {
  const eventId = parseEventId(body.eventId);
  const ticketId = parseTicketId(body.ticketId);
  const qrToken = parseToken(body.qrToken);
  if (!eventId || (!ticketId && !qrToken) || (ticketId && qrToken)) return null;
  return { eventId, ticketId, qrToken };
}

app.post('/tickets/validate', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!(await requireConfigured(res))) return;
  const input = checkinInput(req.body as CheckinInput);
  if (!input) return res.status(200).json({ result: 'INVALID' satisfies Outcome });
  if (!(await requireEventAccess(caller.sub, input.eventId))) return res.status(403).json({ error: 'event_helper_required' });

  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    const selector = input.ticketId ? 'ticket_id = ?' : 'qr_token = ?';
    const value = input.ticketId ?? input.qrToken;
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT ticket_id, event_id, status FROM tickets WHERE ${selector} LIMIT 1 FOR UPDATE`,
      [value],
    );
    const ticket = rows[0];
    if (!ticket) {
      await connection.rollback();
      return res.status(200).json({ result: 'INVALID' satisfies Outcome });
    }

    let result: Outcome;
    if (Number(ticket.event_id) !== input.eventId) {
      result = 'WRONG_EVENT';
    } else if (ticket.status === 'CHECKED_IN') {
      result = 'ALREADY_USED';
    } else if (ticket.status !== 'ISSUED') {
      result = 'INVALID';
    } else {
      await connection.execute(
        'UPDATE tickets SET status = \'CHECKED_IN\', checked_in_at = CURRENT_TIMESTAMP, checked_in_by_sub = ? WHERE ticket_id = ? AND status = \'ISSUED\'',
        [caller.sub, ticket.ticket_id],
      );
      result = 'VALID';
    }
    await connection.execute(
      'INSERT INTO check_in_logs (ticket_id, scanned_by_sub, result) VALUES (?, ?, ?)',
      [ticket.ticket_id, caller.sub, result === 'ALREADY_USED' ? 'DUPLICATE' : result],
    );
    await connection.commit();
    return res.status(200).json({ result });
  } catch (error) {
    await connection.rollback();
    console.error('ticket validation failed', error);
    return res.status(502).json({ error: 'ticket_validation_failed' });
  } finally {
    connection.release();
  }
});

app.get('/customers/me/tickets', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!(await requireConfigured(res))) return;
  const [tickets] = await database.query(
    `SELECT t.ticket_id, t.order_id, t.event_id, e.title AS event_title, e.venue, e.starts_at,
      s.seat_label, t.qr_token, t.status, t.issued_at, t.checked_in_at
     FROM tickets t
     INNER JOIN event_inventory.events e ON e.event_id = t.event_id
     LEFT JOIN event_inventory.seats s ON s.seat_id = t.seat_id
     WHERE t.customer_sub = ?
     ORDER BY e.starts_at ASC, t.ticket_id ASC`,
    [caller.sub],
  );
  return res.json({ tickets });
});

app.get('/tickets/search', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!(await requireConfigured(res))) return;
  const eventId = parseEventId(req.query.eventId);
  const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
  if (!eventId || query.length < 2) return res.status(400).json({ error: 'invalid_search' });
  if (!(await requireEventAccess(caller.sub, eventId))) return res.status(403).json({ error: 'event_helper_required' });
  const orderId = parseTicketId(query);
  const [tickets] = await database.query(
    'SELECT ticket_id, customer_email, seat_id, status FROM tickets WHERE event_id = ? AND (customer_email LIKE ? OR (? IS NOT NULL AND order_id = ?)) ORDER BY ticket_id LIMIT 25',
    [eventId, `%${query}%`, orderId, orderId],
  );
  return res.json({ tickets });
});

app.get('/events/:eventId/checkin-stats', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!(await requireConfigured(res))) return;
  const eventId = parseEventId(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  if (!(await requireEventAccess(caller.sub, eventId))) return res.status(403).json({ error: 'event_helper_required' });
  const [rows] = await database.query<mysql.RowDataPacket[]>(
    'SELECT COUNT(*) AS total, SUM(status = \'CHECKED_IN\') AS checkedIn FROM tickets WHERE event_id = ?',
    [eventId],
  );
  return res.json({ total: Number(rows[0]?.total ?? 0), checkedIn: Number(rows[0]?.checkedIn ?? 0) });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, HOST, () => {
    console.log(`${SERVICE}-service -> http://${HOST}:${PORT}`);
    void consumeOrderPaidEvents();
  });
}

export { app };
