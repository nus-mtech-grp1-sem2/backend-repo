import express from 'express';
import mysql from 'mysql2/promise';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SERVICE = 'ticket';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3005);
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? '';
const CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? '';
const ORDER_EVENTS_QUEUE_URL = process.env.ORDER_EVENTS_QUEUE_URL ?? '';
const SCANNER_SESSION_SECRET = process.env.SCANNER_SESSION_SECRET ?? '';
const SCANNER_SESSION_TTL_MIN = Number(process.env.SCANNER_SESSION_TTL_MIN ?? 480);
const TICKET_INTERNAL_SHARED_SECRET = process.env.TICKET_INTERNAL_SHARED_SECRET ?? '';
const verifier = USER_POOL_ID && CLIENT_ID
  ? CognitoJwtVerifier.create({ userPoolId: USER_POOL_ID, clientId: CLIENT_ID, tokenUse: 'access' })
  : null;
const databaseName = process.env.DB_NAME ?? process.env.DB_NAME_TICKETING ?? '';
const databaseConfigured = Boolean(process.env.DB_HOST && databaseName && process.env.DB_USER && process.env.DB_PASSWORD);
const database = mysql.createPool({
  host: process.env.DB_HOST ?? '',
  port: Number(process.env.DB_PORT ?? 3306),
  database: databaseName,
  user: process.env.DB_USER ?? '',
  password: process.env.DB_PASSWORD ?? '',
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT ?? 8),
  connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT ?? 10000),
  enableKeepAlive: true,
  idleTimeout: Number(process.env.DB_IDLE_TIMEOUT ?? 60000),
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
  readonly email: string;
  readonly name: string;
}

interface ScannerSession {
  readonly sub: string;
  readonly email: string;
  readonly eventId: number;
  readonly role: 'HELPER' | 'ORGANISER';
  readonly exp: number;
}

type ScannerRequest = express.Request & { scanner?: ScannerSession };

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
    const firstName = typeof claims.given_name === 'string' ? claims.given_name : '';
    const lastName = typeof claims.family_name === 'string' ? claims.family_name : '';
    return { sub: String(claims.sub), email: typeof claims.email === 'string' ? claims.email : '', name: `${firstName} ${lastName}`.trim() };
  } catch {
    return null;
  }
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function signScannerSession(session: ScannerSession): string {
  const header = encodeBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = encodeBase64Url(JSON.stringify({ ...session, iat: Math.floor(Date.now() / 1000) }));
  const unsigned = `${header}.${payload}`;
  const signature = createHmac('sha256', SCANNER_SESSION_SECRET).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

export function verifyScannerSession(token: string): ScannerSession | null {
  if (!SCANNER_SESSION_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  if (!header || !payload || !signature) return null;
  const expected = createHmac('sha256', SCANNER_SESSION_SECRET).update(`${header}.${payload}`).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<ScannerSession>;
    const { sub, email, eventId, role, exp } = decoded;
    if (typeof sub !== 'string' || typeof email !== 'string' || typeof eventId !== 'number' || !Number.isSafeInteger(eventId) || eventId < 1 || (role !== 'HELPER' && role !== 'ORGANISER') || typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp <= Math.floor(Date.now() / 1000)) return null;
    return { sub, email, eventId, role, exp };
  } catch {
    return null;
  }
}

export async function requireScannerSession(req: express.Request, res: express.Response): Promise<ScannerSession | null> {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const session = verifyScannerSession(token);
  if (!session) {
    res.status(401).json({ error: 'invalid_scanner_session' });
    return null;
  }
  const [memberships] = await database.query<mysql.RowDataPacket[]>(
    "SELECT role FROM event_inventory.event_team_memberships WHERE event_id = ? AND user_sub = ? AND role = ? AND invite_status = 'ACCEPTED' LIMIT 1",
    [session.eventId, session.sub, session.role],
  );
  if (!memberships[0]) {
    res.status(403).json({ error: 'membership_revoked' });
    return null;
  }
  (req as ScannerRequest).scanner = session;
  return session;
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

app.post('/scanner/sessions', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!(await requireConfigured(res))) return;
  const eventId = parseEventId(req.body?.eventId);
  if (!eventId || Object.keys(req.body ?? {}).some((key) => key !== 'eventId')) {
    res.status(422).json({ error: 'invalid_scanner_session_request' });
    return;
  }
  if (!SCANNER_SESSION_SECRET || !Number.isInteger(SCANNER_SESSION_TTL_MIN) || SCANNER_SESSION_TTL_MIN < 1) {
    res.status(503).json({ error: 'scanner_session_not_configured' });
    return;
  }

  try {
    const [events] = await database.query<mysql.RowDataPacket[]>(
      'SELECT event_id, title, status FROM event_inventory.events WHERE event_id = ? LIMIT 1',
      [eventId],
    );
    const event = events[0];
    if (!event) return res.status(404).json({ error: 'event_not_found' });
    if (event.status === 'CANCELLED') return res.status(409).json({ error: 'event_not_scannable' });

    const [memberships] = await database.query<mysql.RowDataPacket[]>(
      "SELECT role FROM event_inventory.event_team_memberships WHERE event_id = ? AND user_sub = ? AND role IN ('HELPER', 'ORGANISER') AND invite_status = 'ACCEPTED' LIMIT 1",
      [eventId, caller.sub],
    );
    const role = memberships[0]?.role as ScannerSession['role'] | undefined;
    if (!role) return res.status(403).json({ error: 'not_event_staff' });

    const expiresAtSeconds = Math.floor(Date.now() / 1000) + SCANNER_SESSION_TTL_MIN * 60;
    const sessionToken = signScannerSession({ sub: caller.sub, email: caller.email, eventId, role, exp: expiresAtSeconds });
    return res.status(200).json({
      sessionToken,
      eventId,
      eventTitle: event.title,
      role,
      expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    });
  } catch (error) {
    console.error('scanner session issue failed', error);
    return res.status(502).json({ error: 'scanner_session_failed' });
  }
});

app.delete('/scanner/sessions/current', (_req, res) => res.status(204).end());

export function createQrToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function issueTicketsForOrder(orderId: number): Promise<{ issued: number; alreadyIssued: boolean }> {
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    const [orders] = await connection.query<mysql.RowDataPacket[]>(
      "SELECT order_id, event_id, customer_sub, customer_email, status FROM checkout.orders WHERE order_id = ? FOR UPDATE",
      [orderId],
    );
    const order = orders[0];
    if (!order) throw new Error('order_not_found');
    if (order.status !== 'PAID') throw new Error('order_not_paid');
    const [items] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT order_item_id, inventory_item_id, seat_id, description, quantity, unit_price_cents FROM checkout.order_items WHERE order_id = ? ORDER BY order_item_id',
      [orderId],
    );
    let issued = 0;
    for (const item of items) {
      const [existing] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT COUNT(*) AS count FROM ticketing.tickets WHERE order_item_id = ?',
        [item.order_item_id],
      );
      const existingCount = Number(existing[0]?.count ?? 0);
      const quantity = Number(item.quantity);
      for (let unit = existingCount; unit < quantity; unit += 1) {
        await connection.execute(
          `INSERT INTO ticketing.tickets
             (order_id, order_item_id, event_id, customer_sub, customer_email, seat_id, qr_token, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'ISSUED')`,
          [orderId, item.order_item_id, order.event_id, order.customer_sub, order.customer_email, item.seat_id ?? null, createQrToken()],
        );
        issued += 1;
      }
    }
    await connection.commit();
    return { issued, alreadyIssued: issued === 0 };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

app.post('/internal/orders/:orderId/issue-tickets', async (req, res) => {
  if (!TICKET_INTERNAL_SHARED_SECRET || req.header('x-ticket-internal-secret') !== TICKET_INTERNAL_SHARED_SECRET) {
    return res.status(403).json({ error: 'internal_access_denied' });
  }
  const orderId = parseTicketId(req.params.orderId);
  if (!orderId) return res.status(422).json({ error: 'invalid_order' });
  try {
    const result = await issueTicketsForOrder(orderId);
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'order_not_found') return res.status(404).json({ error: error.message });
    if (error instanceof Error && error.message === 'order_not_paid') return res.status(409).json({ error: error.message });
    console.error('ticket issuance failed', error);
    return res.status(502).json({ error: 'ticket_issuance_failed' });
  }
});

export function checkinInput(body: CheckinInput): { eventId: number; ticketId: number | null; qrToken: string | null } | null {
  const eventId = parseEventId(body.eventId);
  const ticketId = parseTicketId(body.ticketId);
  const qrToken = parseToken(body.qrToken);
  if (!eventId || (!ticketId && !qrToken) || (ticketId && qrToken)) return null;
  return { eventId, ticketId, qrToken };
}

interface ScannerCheckinInput {
  readonly qrToken?: unknown;
  readonly ticketId?: unknown;
}

export function parseSearchQuery(query: Record<string, unknown>): string | null {
  if (Object.keys(query).some((key) => key !== 'q')) return null;
  const value = typeof query.q === 'string' ? query.q.trim() : '';
  return value.length >= 3 && value.length <= 255 ? value : null;
}

type ScannerCheckinParse =
  | { readonly ok: true; readonly ticketId: number | null; readonly qrToken: string | null }
  | { readonly ok: false; readonly detail: string };

function scannerCheckinInput(body: ScannerCheckinInput | undefined): ScannerCheckinParse {
  if (!body || typeof body !== 'object') return { ok: false, detail: 'Request body must be a JSON object.' };
  const unknownKeys = Object.keys(body).filter((key) => key !== 'ticketId' && key !== 'qrToken');
  if (unknownKeys.length) return { ok: false, detail: `Unexpected field(s): ${unknownKeys.join(', ')}.` };
  const hasTicketId = body.ticketId !== undefined && body.ticketId !== null;
  const hasQrToken = body.qrToken !== undefined && body.qrToken !== null;
  if (hasTicketId && hasQrToken) return { ok: false, detail: 'Send either ticketId or qrToken, not both.' };
  if (!hasTicketId && !hasQrToken) return { ok: false, detail: 'Either ticketId or qrToken is required.' };
  const ticketId = hasTicketId ? parseTicketId(body.ticketId) : null;
  if (hasTicketId && !ticketId) return { ok: false, detail: 'ticketId must be a positive integer.' };
  const qrToken = hasQrToken ? parseToken(body.qrToken) : null;
  if (hasQrToken && !qrToken) return { ok: false, detail: 'qrToken must be a non-empty string of at most 255 characters.' };
  return { ok: true, ticketId, qrToken };
}

type PublicOutcome = 'SUCCESS' | 'DUPLICATE' | 'INVALID' | 'WRONG_EVENT';

function publicOutcome(status: string | null, sameEvent: boolean): PublicOutcome {
  if (!status) return 'INVALID';
  if (!sameEvent) return 'WRONG_EVENT';
  if (status === 'CHECKED_IN') return 'DUPLICATE';
  if (status === 'VOID') return 'INVALID';
  return 'SUCCESS';
}

function checkinResponse(outcome: PublicOutcome, ticket: mysql.RowDataPacket | null, scannedAt: Date): object {
  const message: Record<PublicOutcome, string> = {
    SUCCESS: 'Ticket accepted. Welcome in.',
    DUPLICATE: 'This ticket has already been checked in.',
    INVALID: 'This ticket is not valid for entry.',
    WRONG_EVENT: 'This ticket belongs to a different event.',
  };
  return {
    outcome,
    message: message[outcome],
    ticket: ticket ? {
      ticketId: Number(ticket.ticket_id),
      eventId: Number(ticket.event_id),
      ticketType: ticket.ticket_type ?? null,
      seatLabel: ticket.seat_label ?? null,
      customerEmail: ticket.customer_email ?? null,
      status: ticket.status,
      checkedInAt: ticket.checked_in_at instanceof Date ? ticket.checked_in_at.toISOString() : ticket.checked_in_at ?? null,
      checkedInBySub: ticket.checked_in_by_sub ?? null,
    } : null,
    scannedAt: scannedAt.toISOString(),
  };
}

app.post('/tickets/validate', async (req, res) => {
  const session = await requireScannerSession(req, res);
  if (!session) return;
  if (!(await requireConfigured(res))) return;
  const input = scannerCheckinInput(req.body as ScannerCheckinInput | undefined);
  if (!input.ok) return res.status(422).json({ error: 'invalid_checkin_request', detail: input.detail });
  const startedAt = Date.now();

  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    const selector = input.ticketId ? 'ticket_id = ?' : 'qr_token = ?';
    const value = input.ticketId ?? input.qrToken;
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT ticket_id, event_id, status, customer_email, checked_in_at, checked_in_by_sub,
              NULL AS ticket_type, NULL AS seat_label
       FROM tickets WHERE ${selector} LIMIT 1 FOR UPDATE`,
      [value],
    );
    const ticket = rows[0];
    if (!ticket) {
      await connection.query(
        'INSERT INTO check_in_logs (ticket_id, scanned_by_sub, result, attempted_token) VALUES (NULL, ?, \'INVALID\', ?)',
        [session.sub, String(value).slice(0, 128)],
      );
      await connection.commit();
      const response = checkinResponse('INVALID', null, new Date());
      console.log(JSON.stringify({ svc: SERVICE, route: '/tickets/validate', eventId: session.eventId, sub: session.sub, outcome: 'INVALID', durationMs: Date.now() - startedAt }));
      return res.status(200).json(response);
    }

    const result = publicOutcome(String(ticket.status), Number(ticket.event_id) === session.eventId);
    if (result === 'SUCCESS') {
      await connection.execute(
        'UPDATE tickets SET status = \'CHECKED_IN\', checked_in_at = CURRENT_TIMESTAMP, checked_in_by_sub = ? WHERE ticket_id = ? AND status = \'ISSUED\'',
        [session.sub, ticket.ticket_id],
      );
      ticket.status = 'CHECKED_IN';
      ticket.checked_in_at = new Date();
      ticket.checked_in_by_sub = session.sub;
    }
    await connection.execute(
      'INSERT INTO check_in_logs (ticket_id, scanned_by_sub, result, attempted_token) VALUES (?, ?, ?, ?)',
      [ticket.ticket_id, session.sub, result, input.qrToken?.slice(0, 128) ?? null],
    );
    await connection.commit();
    console.log(JSON.stringify({ svc: SERVICE, route: '/tickets/validate', eventId: session.eventId, sub: session.sub, outcome: result, durationMs: Date.now() - startedAt }));
    return res.status(200).json(checkinResponse(result, ticket, new Date()));
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
       AND (e.organiser_sub IS NULL OR e.organiser_sub <> ?)
       AND NOT EXISTS (
         SELECT 1 FROM event_inventory.event_team_memberships etm
         WHERE etm.event_id = t.event_id AND etm.user_sub = t.customer_sub
           AND etm.role IN ('ORGANISER', 'HELPER') AND etm.invite_status = 'ACCEPTED'
       )
     ORDER BY e.starts_at ASC, t.ticket_id ASC`,
    [caller.sub, caller.sub],
  );
  return res.json({ tickets });
});

app.get('/tickets/search', async (req, res) => {
  const session = await requireScannerSession(req, res);
  if (!session) return;
  if (!(await requireConfigured(res))) return;
  const startedAt = Date.now();
  const query = parseSearchQuery(req.query as Record<string, unknown>);
  if (!query) return res.status(422).json({ error: 'invalid_search_query' });
  const orderId = parseTicketId(query);
  const [tickets] = await database.query(
    `SELECT ticket_id, customer_name, customer_email, seat_id, status, checked_in_at
     FROM tickets
     WHERE event_id = ?
       AND (customer_name LIKE ? OR customer_email LIKE ? OR (? IS NOT NULL AND order_id = ?))
     ORDER BY ticket_id LIMIT 20`,
    [session.eventId, `%${query}%`, `${query}%`, orderId, orderId],
  );
  console.log(JSON.stringify({ svc: SERVICE, route: '/tickets/search', eventId: session.eventId, sub: session.sub, durationMs: Date.now() - startedAt }));
  return res.json({ tickets });
});

app.get('/customers/me/tickets', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!(await requireConfigured(res))) return;
  try {
    const [tickets] = await database.query<mysql.RowDataPacket[]>(
      `SELECT t.ticket_id, t.event_id, e.title AS event_title, e.venue,
              e.starts_at, t.qr_token, t.status, t.checked_in_at,
              t.seat_id, oi.description AS ticket_type
       FROM tickets t
       JOIN event_inventory.events e ON e.event_id = t.event_id
       LEFT JOIN checkout.order_items oi ON oi.order_item_id = t.order_item_id
       WHERE t.customer_sub = ?
         AND (e.organiser_sub IS NULL OR e.organiser_sub <> ?)
         AND NOT EXISTS (
           SELECT 1 FROM event_inventory.event_team_memberships etm
           WHERE etm.event_id = t.event_id AND etm.user_sub = t.customer_sub
             AND etm.role IN ('ORGANISER', 'HELPER') AND etm.invite_status = 'ACCEPTED'
         )
       ORDER BY e.starts_at DESC, t.ticket_id`,
      [caller.sub, caller.sub],
    );
    return res.json({ tickets });
  } catch (error) {
    console.error('customer tickets lookup failed', error);
    return res.status(502).json({ error: 'tickets_query_failed' });
  }
});

app.get('/tickets/:ticketId', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!(await requireConfigured(res))) return;
  const ticketId = parseTicketId(req.params.ticketId);
  if (!ticketId) return res.status(404).json({ error: 'ticket_not_found' });
  try {
    const [tickets] = await database.query<mysql.RowDataPacket[]>(
      `SELECT t.ticket_id, t.event_id, e.title AS event_title, e.venue,
              e.starts_at, t.qr_token, t.status, t.checked_in_at,
              t.checked_in_by_sub, t.seat_id,
              oi.description AS ticket_type
       FROM tickets t
       JOIN event_inventory.events e ON e.event_id = t.event_id
       LEFT JOIN checkout.order_items oi ON oi.order_item_id = t.order_item_id
       WHERE t.ticket_id = ? AND t.customer_sub = ? LIMIT 1`,
      [ticketId, caller.sub],
    );
    if (!tickets[0]) return res.status(404).json({ error: 'ticket_not_found' });
    return res.json({ ticket: tickets[0] });
  } catch (error) {
    console.error('customer ticket lookup failed', error);
    return res.status(502).json({ error: 'ticket_query_failed' });
  }
});

interface CheckinStatsRow extends mysql.RowDataPacket {
  issued: number;
  checkedIn: number;
  voided: number;
  lastCheckInAt: Date | null;
}

interface TicketTypeStatsRow extends mysql.RowDataPacket {
  ticketType: string;
  issued: number;
  checkedIn: number;
}

async function requireStatsAccess(req: express.Request, res: express.Response, eventId: number): Promise<{ sub: string; eventId: number } | null> {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (verifyScannerSession(token)) {
    const session = await requireScannerSession(req, res);
    if (!session) return null;
    if (session.eventId !== eventId) {
      res.status(403).json({ error: 'event_session_mismatch' });
      return null;
    }
    return { sub: session.sub, eventId };
  }
  const caller = await requireCaller(req, res);
  if (!caller) return null;
  if (!(await requireEventAccess(caller.sub, eventId))) {
    res.status(403).json({ error: 'event_helper_required' });
    return null;
  }
  return { sub: caller.sub, eventId };
}

app.get('/events/:eventId/checkin-stats', async (req, res) => {
  if (!(await requireConfigured(res))) return;
  const eventId = parseEventId(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  try {
    if (!(await requireStatsAccess(req, res, eventId))) return;
    const [rows] = await database.query<CheckinStatsRow[]>(
      `SELECT
         SUM(status IN ('ISSUED', 'CHECKED_IN')) AS issued,
         SUM(status = 'CHECKED_IN') AS checkedIn,
         SUM(status = 'VOID') AS voided,
         MAX(checked_in_at) AS lastCheckInAt
       FROM tickets WHERE event_id = ?`,
      [eventId],
    );
    const [typeRows] = await database.query<TicketTypeStatsRow[]>(
      `SELECT COALESCE(oi.description, 'Unknown') AS ticketType,
              SUM(t.status IN ('ISSUED', 'CHECKED_IN')) AS issued,
              SUM(t.status = 'CHECKED_IN') AS checkedIn
       FROM tickets t
       LEFT JOIN checkout.order_items oi ON oi.order_item_id = t.order_item_id
       WHERE t.event_id = ? GROUP BY COALESCE(oi.description, 'Unknown')`,
      [eventId],
    );
    const row = rows[0];
    const issued = Number(row?.issued ?? 0);
    const checkedIn = Number(row?.checkedIn ?? 0);
    return res.set('Cache-Control', 'no-store').json({
      eventId,
      issued,
      checkedIn,
      remaining: Math.max(issued - checkedIn, 0),
      void: Number(row?.voided ?? 0),
      lastCheckInAt: row?.lastCheckInAt instanceof Date ? row.lastCheckInAt.toISOString() : row?.lastCheckInAt ?? null,
      byTicketType: typeRows.map((type) => ({ ticketType: type.ticketType, issued: Number(type.issued), checkedIn: Number(type.checkedIn) })),
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('check-in stats lookup failed', error);
    return res.status(502).json({ error: 'check_in_stats_failed' });
  }
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, HOST, () => {
    console.log(`${SERVICE}-service -> http://${HOST}:${PORT}`);
    void consumeOrderPaidEvents();
  });
}

export { app };
