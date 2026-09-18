import express from 'express';
import mysql from 'mysql2/promise';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

const SERVICE = 'ticket';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3005);
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? '';
const CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? '';
let verifier = USER_POOL_ID && CLIENT_ID
  ? CognitoJwtVerifier.create({ userPoolId: USER_POOL_ID, clientId: CLIENT_ID, tokenUse: 'access' })
  : null;

/**
 * Test-only seam: swaps the Cognito verifier for a fake one so tests can
 * authenticate as a known `sub` without a real Cognito token. Never called
 * outside test code — production always uses the verifier built above from
 * real Cognito env vars.
 */
export function __setVerifierForTests(fake: typeof verifier): void {
  verifier = fake;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: SERVICE });
});

// docker-compose sets DB_NAME to this service's schema directly; running
// outside docker (dev:local, tests) only has the per-schema DB_NAME_* vars
// from the root .env, so fall back to that.
const database = mysql.createPool({
  host: process.env.DB_HOST ?? '',
  port: Number(process.env.DB_PORT ?? 3306),
  database: process.env.DB_NAME ?? process.env.DB_NAME_TICKETING ?? '',
  user: process.env.DB_USER ?? '',
  password: process.env.DB_PASSWORD ?? '',
  connectionLimit: 4,
  ...(process.env.DB_SSL === 'false' ? {} : { ssl: { rejectUnauthorized: false } }),
});

interface Caller {
  readonly sub: string;
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

async function requireAuthenticated(req: express.Request, res: express.Response): Promise<Caller | null> {
  const caller = await authenticate(req);
  if (!caller) {
    res.status(401).json({ error: 'unauthenticated' });
    return null;
  }
  return caller;
}

// -----------------------------------------------------------------------
// GET /customers/me/tickets — the signed-in customer's own issued tickets.
// Tickets themselves are issued by the Checkout & Payment Service
// (services/order) once a payment is captured; this service is the source
// of truth once a ticket exists.
// -----------------------------------------------------------------------

interface MyTicketRow extends mysql.RowDataPacket {
  ticket_id: number;
  event_id: number;
  event_title: string;
  venue: string;
  starts_at: Date;
  seat_label: string | null;
  qr_token: string;
  status: 'ISSUED' | 'CHECKED_IN' | 'VOID';
}

app.get('/customers/me/tickets', async (req, res) => {
  const caller = await requireAuthenticated(req, res);
  if (!caller) return;

  const [rows] = await database.query<MyTicketRow[]>(
    `SELECT
       t.ticket_id, t.event_id, e.title AS event_title, e.venue, e.starts_at,
       s.seat_label, t.qr_token, t.status
     FROM tickets t
     JOIN event_inventory.events e ON e.event_id = t.event_id
     LEFT JOIN event_inventory.seats s ON s.seat_id = t.seat_id
     WHERE t.customer_sub = ?
     ORDER BY e.starts_at DESC`,
    [caller.sub],
  );

  res.json({
    tickets: rows.map((row) => ({
      ticket_id: row.ticket_id,
      event_id: row.event_id,
      event_title: row.event_title,
      venue: row.venue,
      starts_at: row.starts_at,
      seat_label: row.seat_label,
      qr_token: row.qr_token,
      status: row.status,
    })),
  });
});

// Guarded so importing this module from tests (NODE_ENV=test) doesn't also
// bind the real port — tests start their own ephemeral listener via `app`.
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, HOST, () => {
    console.log(`${SERVICE}-service -> http://${HOST}:${PORT}`);
  });
}

export { app, database };
