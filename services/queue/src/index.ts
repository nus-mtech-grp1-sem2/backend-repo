import { randomBytes } from 'node:crypto';

import express from 'express';
import mysql from 'mysql2/promise';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

const SERVICE = 'queue';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3003);
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN ?? '';
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? '';
const CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? '';
const verifier = USER_POOL_ID && CLIENT_ID
  ? CognitoJwtVerifier.create({ userPoolId: USER_POOL_ID, clientId: CLIENT_ID, tokenUse: 'access' })
  : null;

const databaseConfigured = Boolean(
  process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER && process.env.DB_PASSWORD,
);
const database = mysql.createPool({
  host: process.env.DB_HOST ?? '',
  port: Number(process.env.DB_PORT ?? 3306),
  database: process.env.DB_NAME ?? '',
  user: process.env.DB_USER ?? '',
  password: process.env.DB_PASSWORD ?? '',
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT ?? 8),
  connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT ?? 10_000),
  ...(process.env.DB_SSL === 'false' ? {} : { ssl: { rejectUnauthorized: false } }),
});

interface Caller { readonly sub: string }
interface QueueConfigInput {
  readonly opensAt?: unknown;
  readonly admissionBatchSize?: unknown;
  readonly admissionIntervalSec?: unknown;
}
interface QueueEntryRow extends mysql.RowDataPacket {
  readonly queue_entry_id: number;
  readonly position: number;
  readonly status: 'WAITING' | 'ADMITTED' | 'IN_CHECKOUT' | 'EXPIRED' | 'LEFT';
  readonly admission_token: string | null;
  readonly token_expires_at: Date | null;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.get('/health', (_req, res) => res.json({ status: 'ok', service: SERVICE }));

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

const TOKEN_TTL_SEC = positiveInteger(process.env.ADMISSION_TOKEN_TTL_SEC) ?? 600;

function parseConfig(input: QueueConfigInput): {
  opensAt: string;
  admissionBatchSize: number;
  admissionIntervalSec: number;
} | null {
  const opensAt = typeof input.opensAt === 'string' ? input.opensAt.trim() : '';
  const admissionBatchSize = positiveInteger(input.admissionBatchSize);
  const admissionIntervalSec = positiveInteger(input.admissionIntervalSec);
  if (!opensAt || Number.isNaN(Date.parse(opensAt)) || !admissionBatchSize || admissionBatchSize > 10_000 ||
      !admissionIntervalSec || admissionIntervalSec > 86_400) return null;
  return { opensAt, admissionBatchSize, admissionIntervalSec };
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

async function requireCaller(req: express.Request, res: express.Response): Promise<Caller | null> {
  const caller = await authenticate(req);
  if (!caller) res.status(401).json({ error: 'unauthenticated' });
  return caller;
}

function requireDatabase(res: express.Response): boolean {
  if (!databaseConfigured) res.status(503).json({ error: 'database_not_configured' });
  return databaseConfigured;
}

async function hasEventRole(eventId: number, sub: string, roles: readonly string[]): Promise<boolean> {
  const placeholders = roles.map(() => '?').join(', ');
  const [rows] = await database.query<mysql.RowDataPacket[]>(
    `SELECT membership_id FROM event_inventory.event_team_memberships
     WHERE event_id = ? AND user_sub = ? AND role IN (${placeholders}) AND invite_status = 'ACCEPTED' LIMIT 1`,
    [eventId, sub, ...roles],
  );
  return rows.length > 0;
}

function queueEntryResponse(entry: QueueEntryRow, livePosition?: number) {
  return {
    queueEntryId: Number(entry.queue_entry_id),
    status: entry.status,
    ...(entry.status === 'WAITING' ? { position: livePosition ?? Number(entry.position) } : {}),
    ...(entry.status === 'ADMITTED' ? {
      admissionToken: entry.admission_token ?? undefined,
      tokenExpiresAt: entry.token_expires_at ?? undefined,
    } : {}),
  };
}

app.put('/events/:eventId/queue/config', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!requireDatabase(res)) return;
  const eventId = positiveInteger(req.params.eventId);
  const input = parseConfig(req.body as QueueConfigInput);
  if (!eventId || !input) 
    return res.status(400).json({ error: 'invalid_queue_config' });
  if (!(await hasEventRole(eventId, caller.sub, ['ORGANISER']))) {
    return res.status(403).json({ error: 'event_organiser_required' });
  }
  const [events] = await database.query<mysql.RowDataPacket[]>(
    'SELECT tier FROM event_inventory.events WHERE event_id = ? LIMIT 1', [eventId],
  );
  if (!events[0]) 
    return res.status(404).json({ error: 'event_not_found' });
  if (events[0].tier !== 'TIER2_SEATED') 
    return res.status(409).json({ error: 'queue_only_supported_for_tier2' });

  const status = Date.parse(input.opensAt) <= Date.now() ? 'OPEN' : 'CLOSED';
  await database.execute(
    `INSERT INTO queue_sessions (event_id, opens_at, admission_batch_size, admission_interval_sec, status)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE opens_at = VALUES(opens_at), admission_batch_size = VALUES(admission_batch_size),
       admission_interval_sec = VALUES(admission_interval_sec), status = VALUES(status)`,
    [eventId, input.opensAt, input.admissionBatchSize, input.admissionIntervalSec, status],
  );
  const [sessions] = await database.query<mysql.RowDataPacket[]>(
    'SELECT queue_session_id, event_id, opens_at, admission_batch_size, admission_interval_sec, status FROM queue_sessions WHERE event_id = ? LIMIT 1',
    [eventId],
  );
  return res.json({ queueSession: sessions[0] });
});

app.post('/events/:eventId/queue/join', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!requireDatabase(res)) return;
  const eventId = positiveInteger(req.params.eventId);
  if (!eventId) 
    return res.status(400).json({ error: 'invalid_event' });
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    const [sessions] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT queue_session_id, opens_at, status FROM queue_sessions WHERE event_id = ? LIMIT 1 FOR UPDATE', [eventId],
    );
    const session = sessions[0];
    if (!session) { await connection.rollback(); return res.status(404).json({ error: 'queue_not_configured' }); }
    if (session.status === 'CLOSED' && new Date(session.opens_at).getTime() <= Date.now()) {
      await connection.execute("UPDATE queue_sessions SET status = 'OPEN' WHERE queue_session_id = ?", [session.queue_session_id]);
      session.status = 'OPEN';
    }
    if (session.status !== 'OPEN') {
      await connection.rollback();
      return res.status(409).json({ error: session.status === 'DRAINED' ? 'queue_drained' : 'queue_not_open' });
    }
    const [existingRows] = await connection.query<QueueEntryRow[]>(
      'SELECT queue_entry_id, position, status, admission_token, token_expires_at FROM queue_entries WHERE queue_session_id = ? AND customer_sub = ? LIMIT 1 FOR UPDATE',
      [session.queue_session_id, caller.sub],
    );
    let entry = existingRows[0];
    const tokenExpired = entry?.status === 'ADMITTED' && entry.token_expires_at && new Date(entry.token_expires_at).getTime() <= Date.now();
    if (entry && !tokenExpired && ['WAITING', 'ADMITTED', 'IN_CHECKOUT'].includes(entry.status)) {
      await connection.commit();
      return res.json(queueEntryResponse(entry));
    }
    const [positions] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM queue_entries WHERE queue_session_id = ?',
      [session.queue_session_id],
    );
    const position = Number(positions[0]?.next_position ?? 1);
    if (entry) {
      await connection.execute(
        "UPDATE queue_entries SET position = ?, status = 'WAITING', joined_at = CURRENT_TIMESTAMP, admitted_at = NULL, admission_token = NULL, token_expires_at = NULL WHERE queue_entry_id = ?",
        [position, entry.queue_entry_id],
      );
      entry = { ...entry, position, status: 'WAITING', admission_token: null, token_expires_at: null };
    } else {
      const [insert] = await connection.execute<mysql.ResultSetHeader>(
        'INSERT INTO queue_entries (queue_session_id, customer_sub, position) VALUES (?, ?, ?)',
        [session.queue_session_id, caller.sub, position],
      );
      entry = { queue_entry_id: insert.insertId, position, status: 'WAITING', admission_token: null, token_expires_at: null } as QueueEntryRow;
    }
    await connection.commit();
    return res.status(201).json(queueEntryResponse(entry));
  } catch (error) {
    await connection.rollback();
    console.error('queue join failed', error);
    return res.status(502).json({ error: 'queue_join_failed' });
  } finally { connection.release(); }
});

app.get('/events/:eventId/queue/me', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!requireDatabase(res)) return;
  const eventId = positiveInteger(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  await database.execute(
    `UPDATE queue_entries e INNER JOIN queue_sessions s ON s.queue_session_id = e.queue_session_id
     SET e.status = 'EXPIRED', e.admission_token = NULL
     WHERE s.event_id = ? AND e.customer_sub = ? AND e.status = 'ADMITTED' AND e.token_expires_at <= CURRENT_TIMESTAMP`,
    [eventId, caller.sub],
  );
  const [rows] = await database.query<QueueEntryRow[]>(
    `SELECT e.queue_entry_id, e.position, e.status, e.admission_token, e.token_expires_at
     FROM queue_entries e INNER JOIN queue_sessions s ON s.queue_session_id = e.queue_session_id
     WHERE s.event_id = ? AND e.customer_sub = ? LIMIT 1`, [eventId, caller.sub],
  );
  const entry = rows[0];
  if (!entry) return res.status(404).json({ error: 'queue_entry_not_found' });
  let livePosition: number | undefined;
  if (entry.status === 'WAITING') {
    const [counts] = await database.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS live_position FROM queue_entries e INNER JOIN queue_sessions s ON s.queue_session_id = e.queue_session_id
       WHERE s.event_id = ? AND e.status = 'WAITING' AND e.position <= ?`, [eventId, entry.position],
    );
    livePosition = Number(counts[0]?.live_position ?? entry.position);
  }
  return res.json(queueEntryResponse(entry, livePosition));
});

app.post('/events/:eventId/queue/admit-next', async (req, res) => {
  const eventId = positiveInteger(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  if (!INTERNAL_API_TOKEN) return res.status(503).json({ error: 'internal_auth_not_configured' });
  if (req.header('x-internal-token') !== INTERNAL_API_TOKEN) return res.status(401).json({ error: 'unauthenticated' });
  if (!requireDatabase(res)) return;
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    const [sessions] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT queue_session_id, admission_batch_size, admission_interval_sec, status FROM queue_sessions WHERE event_id = ? LIMIT 1 FOR UPDATE', [eventId],
    );
    const session = sessions[0];
    if (!session) { await connection.rollback(); return res.status(404).json({ error: 'queue_not_configured' }); }
    if (session.status !== 'OPEN') { await connection.rollback(); return res.status(409).json({ error: 'queue_not_open' }); }
    const [recent] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT MAX(admitted_at) AS last_admitted_at FROM queue_entries WHERE queue_session_id = ?', [session.queue_session_id],
    );
    const lastAdmittedAt = recent[0]?.last_admitted_at ? new Date(recent[0].last_admitted_at).getTime() : 0;
    if (lastAdmittedAt + Number(session.admission_interval_sec) * 1_000 > Date.now()) {
      await connection.rollback(); return res.status(429).json({ error: 'admission_interval_not_elapsed' });
    }
    const [availabilityRows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT e.status, e.tier,
        CASE WHEN e.tier = 'TIER2_SEATED'
          THEN (SELECT COUNT(*) FROM event_inventory.seats WHERE event_id = e.event_id AND status = 'AVAILABLE')
          ELSE (SELECT COALESCE(SUM(total_qty - reserved_qty - sold_qty), 0) FROM event_inventory.inventory_items WHERE event_id = e.event_id)
        END AS available_qty
       FROM event_inventory.events e WHERE e.event_id = ? LIMIT 1`, [eventId],
    );
    const event = availabilityRows[0];
    if (!event || event.status !== 'PUBLISHED') { await connection.rollback(); return res.status(409).json({ error: 'event_not_on_sale' }); }
    const limit = Math.min(Number(session.admission_batch_size), Number(event.available_qty ?? 0));
    if (limit <= 0) {
      await connection.execute("UPDATE queue_sessions SET status = 'DRAINED' WHERE queue_session_id = ?", [session.queue_session_id]);
      await connection.commit();
      return res.json({ admitted: 0, remaining: null, reason: 'sold_out' });
    }
    const [waiting] = await connection.query<QueueEntryRow[]>(
      `SELECT queue_entry_id, position, status, admission_token, token_expires_at FROM queue_entries
       WHERE queue_session_id = ? AND status = 'WAITING' ORDER BY position LIMIT ? FOR UPDATE`,
      [session.queue_session_id, limit],
    );
    for (const entry of waiting) {
      await connection.execute(
        `UPDATE queue_entries SET status = 'ADMITTED', admitted_at = CURRENT_TIMESTAMP, admission_token = ?,
          token_expires_at = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? SECOND) WHERE queue_entry_id = ?`,
        [randomBytes(32).toString('base64url'), TOKEN_TTL_SEC, entry.queue_entry_id],
      );
    }
    const [remainingRows] = await connection.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS remaining FROM queue_entries WHERE queue_session_id = ? AND status = 'WAITING'", [session.queue_session_id],
    );
    const remaining = Number(remainingRows[0]?.remaining ?? 0);
    await connection.commit();
    return res.json({ admitted: waiting.length, remaining });
  } catch (error) {
    await connection.rollback();
    console.error('queue admission failed', error);
    return res.status(502).json({ error: 'queue_admission_failed' });
  } finally { connection.release(); }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('unhandled queue error', error);
  if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
});

if (process.env.NODE_ENV !== 'test') app.listen(PORT, HOST, () => console.log(`${SERVICE}-service -> http://${HOST}:${PORT}`));

export { app, parseConfig, positiveInteger };
