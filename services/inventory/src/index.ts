import express from 'express';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import mysql from 'mysql2/promise';

const SERVICE = 'inventory';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3002);
const verifier = process.env.COGNITO_USER_POOL_ID && process.env.COGNITO_CLIENT_ID
  ? CognitoJwtVerifier.create({ userPoolId: process.env.COGNITO_USER_POOL_ID, clientId: process.env.COGNITO_CLIENT_ID, tokenUse: 'access' })
  : null;
const database = mysql.createPool({
  host: process.env.DB_HOST ?? '', port: Number(process.env.DB_PORT ?? 3306),
  database: process.env.DB_NAME ?? process.env.DB_NAME_EVENT_INVENTORY ?? 'event_inventory',
  user: process.env.DB_USER ?? '', password: process.env.DB_PASSWORD ?? '',
  waitForConnections: true, connectionLimit: Number(process.env.DB_CONNECTION_LIMIT ?? 8),
  connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT ?? 10000),
  ...(process.env.DB_SSL === 'false' ? {} : { ssl: { rejectUnauthorized: false } }),
});
const databaseConfigured = Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD);

interface Caller { readonly sub: string; }
const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.get('/health', (_req, res) => res.json({ status: 'ok', service: SERVICE }));

async function caller(req: express.Request, res: express.Response): Promise<Caller | null> {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !verifier) { res.status(401).json({ error: 'unauthenticated' }); return null; }
  try { const claims = await verifier.verify(token); return { sub: String(claims.sub) }; }
  catch { res.status(401).json({ error: 'unauthenticated' }); return null; }
}

export function positiveId(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function nonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function organiser(sub: string, eventId: number): Promise<boolean> {
  const [rows] = await database.query<mysql.RowDataPacket[]>(
    "SELECT membership_id FROM event_team_memberships WHERE event_id = ? AND user_sub = ? AND role = 'ORGANISER' AND invite_status = 'ACCEPTED' LIMIT 1", [eventId, sub]);
  return rows.length > 0;
}

app.get('/events/:eventId/seats', async (req, res) => {
  const eventId = positiveId(req.params.eventId);
  if (!databaseConfigured) return res.status(503).json({ error: 'database_not_configured' });
  if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  const [seats] = await database.query('SELECT seat_id, seat_label, status FROM seats WHERE event_id = ? ORDER BY seat_id', [eventId]);
  return res.json({ seats });
});

app.put('/events/:eventId/inventory', async (req, res) => {
  const eventId = positiveId(req.params.eventId);
  const user = await caller(req, res);
  if (!user || !eventId) return res.status(user ? 400 : 401).json({ error: 'invalid_inventory_request' });
  const totalQty = positiveId(req.body?.totalQty);
  const priceCents = nonNegativeInteger(req.body?.priceCents);
  if (!totalQty || priceCents === null || !(await organiser(user.sub, eventId))) return res.status(400).json({ error: 'invalid_inventory_request' });
  const [existing] = await database.query<mysql.RowDataPacket[]>("SELECT inventory_item_id FROM inventory_items WHERE event_id = ? AND name = 'General Admission' LIMIT 1", [eventId]);
  if (existing[0]) {
    await database.execute('UPDATE inventory_items SET total_qty = ?, price_cents = ? WHERE inventory_item_id = ?', [totalQty, priceCents, existing[0].inventory_item_id]);
  } else {
    await database.execute("INSERT INTO inventory_items (event_id, name, total_qty, price_cents) VALUES (?, 'General Admission', ?, ?)", [eventId, totalQty, priceCents]);
  }
  return res.status(204).end();
});

app.post('/events/:eventId/inventory/hold', async (req, res) => {
  const eventId = positiveId(req.params.eventId);
  const user = await caller(req, res);
  if (!user || !eventId) return res.status(user ? 400 : 401).json({ error: 'invalid_hold_request' });
  const seatIds: (number | null)[] = Array.isArray(req.body?.seatIds)
    ? (req.body.seatIds as unknown[]).map(positiveId)
    : [];
  const quantity = positiveId(req.body?.quantity) ?? (seatIds.length || null);
  if (!quantity || (seatIds.length > 0 && seatIds.some((seatId): seatId is number => seatId === null))) return res.status(422).json({ error: 'invalid_hold_request' });
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    const [items] = await connection.query<mysql.RowDataPacket[]>("SELECT inventory_item_id, total_qty, reserved_qty, sold_qty FROM inventory_items WHERE event_id = ? AND name = 'General Admission' LIMIT 1 FOR UPDATE", [eventId]);
    const item = items[0];
    if (!item || Number(item.total_qty) - Number(item.reserved_qty) - Number(item.sold_qty) < quantity) { await connection.rollback(); return res.status(409).json({ error: 'insufficient_inventory' }); }
    if (seatIds.length > 0) {
      const [seats] = await connection.query<mysql.RowDataPacket[]>(`SELECT seat_id FROM seats WHERE event_id = ? AND seat_id IN (${seatIds.map(() => '?').join(',')}) AND status = 'AVAILABLE' FOR UPDATE`, [eventId, ...seatIds]);
      if (seats.length !== seatIds.length) { await connection.rollback(); return res.status(409).json({ error: 'seat_unavailable' }); }
    }
    await connection.execute('UPDATE inventory_items SET reserved_qty = reserved_qty + ? WHERE inventory_item_id = ?', [quantity, item.inventory_item_id]);
    const [hold] = await connection.execute<mysql.ResultSetHeader>(`INSERT INTO inventory_holds (event_id, inventory_item_id, customer_sub, quantity, status, expires_at) VALUES (?, ?, ?, ?, 'ACTIVE', DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 3 MINUTE))`, [eventId, item.inventory_item_id, user.sub, quantity]);
    if (seatIds.length > 0) await connection.query(`UPDATE seats SET status = 'HELD', hold_id = ? WHERE seat_id IN (${seatIds.map(() => '?').join(',')})`, [hold.insertId, ...seatIds]);
    await connection.commit();
    return res.status(201).json({ holdId: hold.insertId, eventId, quantity, expiresAt: new Date(Date.now() + 180_000).toISOString() });
  } catch (error) { await connection.rollback(); console.error('inventory hold failed', error); return res.status(502).json({ error: 'hold_failed' }); }
  finally { connection.release(); }
});

async function finishHold(req: express.Request, res: express.Response, status: 'RELEASED' | 'CONFIRMED') {
  const holdId = positiveId(req.params.holdId); const user = await caller(req, res);
  if (!user || !holdId) return res.status(user ? 400 : 401).json({ error: 'invalid_hold' });
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    const [holds] = await connection.query<mysql.RowDataPacket[]>('SELECT hold_id, inventory_item_id, quantity, status FROM inventory_holds WHERE hold_id = ? AND customer_sub = ? FOR UPDATE', [holdId, user.sub]);
    const hold = holds[0];
    if (!hold) { await connection.rollback(); return res.status(404).json({ error: 'hold_not_found' }); }
    if (hold.status !== 'ACTIVE') { await connection.rollback(); return res.status(409).json({ error: 'hold_not_active' }); }
    await connection.execute(`UPDATE inventory_holds SET status = ? WHERE hold_id = ?`, [status, holdId]);
    await connection.execute(`UPDATE inventory_items SET reserved_qty = reserved_qty - ?, sold_qty = sold_qty + ? WHERE inventory_item_id = ?`, [hold.quantity, status === 'CONFIRMED' ? hold.quantity : 0, hold.inventory_item_id]);
    await connection.execute(`UPDATE seats SET status = ?, hold_id = NULL WHERE hold_id = ?`, [status === 'CONFIRMED' ? 'SOLD' : 'AVAILABLE', holdId]);
    await connection.commit(); return res.json({ holdId, status });
  } catch (error) { await connection.rollback(); console.error('inventory hold transition failed', error); return res.status(502).json({ error: 'hold_transition_failed' }); }
  finally { connection.release(); }
}
app.post('/holds/:holdId/release', (req, res) => finishHold(req, res, 'RELEASED'));
app.post('/holds/:holdId/confirm', (req, res) => finishHold(req, res, 'CONFIRMED'));

if (process.env.NODE_ENV !== 'test') app.listen(PORT, HOST, () => console.log(`${SERVICE}-service -> http://${HOST}:${PORT}`));
export { app };
