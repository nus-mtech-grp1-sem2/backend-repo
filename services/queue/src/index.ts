import express from 'express';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import mysql from 'mysql2/promise';
import { randomBytes } from 'node:crypto';

const SERVICE = 'queue';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3003);
const verifier = process.env.COGNITO_USER_POOL_ID && process.env.COGNITO_CLIENT_ID
  ? CognitoJwtVerifier.create({ userPoolId: process.env.COGNITO_USER_POOL_ID, clientId: process.env.COGNITO_CLIENT_ID, tokenUse: 'access' })
  : null;
const database = mysql.createPool({
  host: process.env.DB_HOST ?? '', port: Number(process.env.DB_PORT ?? 3306),
  database: process.env.DB_NAME ?? process.env.DB_NAME_QUEUE ?? 'queue', user: process.env.DB_USER ?? '', password: process.env.DB_PASSWORD ?? '',
  waitForConnections: true, connectionLimit: Number(process.env.DB_CONNECTION_LIMIT ?? 8), connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT ?? 10000),
  ...(process.env.DB_SSL === 'false' ? {} : { ssl: { rejectUnauthorized: false } }),
});

interface Caller { readonly sub: string; }
const app = express(); app.disable('x-powered-by'); app.use(express.json());
app.get('/health', (_req, res) => res.json({ status: 'ok', service: SERVICE }));
function positive(value: unknown): number | null { const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN; return Number.isSafeInteger(n) && n > 0 ? n : null; }
function mysqlDateTime(value: string): string { return value.replace('T', ' ').replace(/\.\d{3}Z$/, '').replace('Z', ''); }
async function caller(req: express.Request, res: express.Response): Promise<Caller | null> {
  const raw = req.header('authorization') ?? ''; const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
  if (!token || !verifier) { res.status(401).json({ error: 'unauthenticated' }); return null; }
  try { const claims = await verifier.verify(token); return { sub: String(claims.sub) }; } catch { res.status(401).json({ error: 'unauthenticated' }); return null; }
}
async function organiser(sub: string, eventId: number): Promise<boolean> {
  const [rows] = await database.query<mysql.RowDataPacket[]>("SELECT membership_id FROM event_inventory.event_team_memberships WHERE event_id = ? AND user_sub = ? AND role = 'ORGANISER' AND invite_status = 'ACCEPTED' LIMIT 1", [eventId, sub]); return rows.length > 0;
}
async function requireOrganiser(req: express.Request, res: express.Response, eventId: number): Promise<Caller | null> {
  const user = await caller(req, res); if (!user) return null; if (!(await organiser(user.sub, eventId))) { res.status(403).json({ error: 'event_organiser_required' }); return null; } return user;
}
function view(entry: mysql.RowDataPacket | undefined): object { return entry ? { status: entry.status, position: entry.position ?? undefined, admissionToken: entry.admission_token ?? undefined } : { status: 'LEFT' }; }

app.put('/events/:eventId/queue/config', async (req, res) => {
  const eventId = positive(req.params.eventId); if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  const user = await requireOrganiser(req, res, eventId); if (!user) return;
  const opensAt = typeof req.body?.opensAt === 'string' ? req.body.opensAt : ''; const batch = positive(req.body?.admissionBatchSize); const interval = positive(req.body?.admissionIntervalSec);
  if (!opensAt || Number.isNaN(Date.parse(opensAt)) || !batch || !interval) return res.status(422).json({ error: 'invalid_queue_config' });
  const databaseOpensAt = mysqlDateTime(opensAt);
  const [existing] = await database.query<mysql.RowDataPacket[]>('SELECT queue_session_id FROM queue_sessions WHERE event_id = ? ORDER BY queue_session_id DESC LIMIT 1', [eventId]);
  if (existing[0]) await database.execute("UPDATE queue_sessions SET opens_at = ?, admission_batch_size = ?, admission_interval_sec = ?, status = 'OPEN' WHERE queue_session_id = ?", [databaseOpensAt, batch, interval, existing[0].queue_session_id]);
  else await database.execute("INSERT INTO queue_sessions (event_id, opens_at, admission_batch_size, admission_interval_sec, status) VALUES (?, ?, ?, ?, 'OPEN')", [eventId, databaseOpensAt, batch, interval]);
  return res.status(204).end();
});

app.post('/events/:eventId/queue/join', async (req, res) => {
  const eventId = positive(req.params.eventId); const user = await caller(req, res); if (!user || !eventId) return res.status(user ? 400 : 401).json({ error: 'invalid_queue_request' });
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    const [sessions] = await connection.query<mysql.RowDataPacket[]>("SELECT queue_session_id FROM queue_sessions WHERE event_id = ? AND status = 'OPEN' ORDER BY queue_session_id DESC LIMIT 1 FOR UPDATE", [eventId]);
    const session = sessions[0]; if (!session) { await connection.rollback(); return res.status(409).json({ error: 'queue_closed' }); }
    const [existing] = await connection.query<mysql.RowDataPacket[]>('SELECT status, position, admission_token FROM queue_entries WHERE queue_session_id = ? AND customer_sub = ? LIMIT 1 FOR UPDATE', [session.queue_session_id, user.sub]);
    if (existing[0]) { await connection.commit(); return res.json(view(existing[0])); }
    const [count] = await connection.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS waiting FROM queue_entries WHERE queue_session_id = ? AND status = 'WAITING'", [session.queue_session_id]);
    const position = Number(count[0]?.waiting ?? 0) + 1;
    await connection.execute("INSERT INTO queue_entries (queue_session_id, customer_sub, position, status) VALUES (?, ?, ?, 'WAITING')", [session.queue_session_id, user.sub, position]);
    await connection.commit(); return res.status(201).json({ status: 'WAITING', position });
  } catch (error) { await connection.rollback(); console.error('queue join failed', error); return res.status(502).json({ error: 'queue_join_failed' }); } finally { connection.release(); }
});

app.get('/events/:eventId/queue/me', async (req, res) => {
  const eventId = positive(req.params.eventId); const user = await caller(req, res); if (!user || !eventId) return res.status(user ? 400 : 401).json({ error: 'invalid_queue_request' });
  const [rows] = await database.query<mysql.RowDataPacket[]>('SELECT qe.status, qe.position, qe.admission_token FROM queue_entries qe JOIN queue_sessions qs ON qs.queue_session_id = qe.queue_session_id WHERE qs.event_id = ? AND qe.customer_sub = ? ORDER BY qe.queue_entry_id DESC LIMIT 1', [eventId, user.sub]);
  return res.json(view(rows[0]));
});

app.post('/events/:eventId/queue/admit-next', async (req, res) => {
  const eventId = positive(req.params.eventId); if (!eventId) return res.status(400).json({ error: 'invalid_event' }); const user = await requireOrganiser(req, res, eventId); if (!user) return;
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    const [entries] = await connection.query<mysql.RowDataPacket[]>(`SELECT qe.queue_entry_id FROM queue_entries qe JOIN queue_sessions qs ON qs.queue_session_id = qe.queue_session_id WHERE qs.event_id = ? AND qs.status = 'OPEN' AND qe.status = 'WAITING' ORDER BY qe.position LIMIT 1 FOR UPDATE`, [eventId]);
    const entry = entries[0]; if (!entry) { await connection.rollback(); return res.status(404).json({ error: 'queue_empty' }); }
    const token = randomBytes(24).toString('base64url'); await connection.execute("UPDATE queue_entries SET status = 'ADMITTED', admission_token = ?, admitted_at = CURRENT_TIMESTAMP, token_expires_at = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 15 MINUTE) WHERE queue_entry_id = ?", [token, entry.queue_entry_id]);
    await connection.commit(); return res.json({ status: 'ADMITTED', admissionToken: token });
  } catch (error) { await connection.rollback(); console.error('queue admission failed', error); return res.status(502).json({ error: 'queue_admit_failed' }); } finally { connection.release(); }
});

if (process.env.NODE_ENV !== 'test') app.listen(PORT, HOST, () => console.log(`${SERVICE}-service -> http://${HOST}:${PORT}`));
export { app };
