import express from 'express';
import mysql from 'mysql2/promise';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

const SERVICE = 'ticket';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3005);
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? '';
const CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? '';
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
  });
}

export { app };
