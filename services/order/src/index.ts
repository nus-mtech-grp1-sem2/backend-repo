import express from 'express';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import mysql from 'mysql2/promise';

const SERVICE = 'order';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3004);
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? '';
const CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? '';
const TICKET_SERVICE_URL = process.env.TICKET_SERVICE_URL ?? 'http://ticket:3005';
const TICKET_INTERNAL_SHARED_SECRET = process.env.TICKET_INTERNAL_SHARED_SECRET ?? '';
const verifier = USER_POOL_ID && CLIENT_ID
  ? CognitoJwtVerifier.create({ userPoolId: USER_POOL_ID, clientId: CLIENT_ID, tokenUse: 'access' })
  : null;
const databaseName = process.env.DB_NAME ?? process.env.DB_NAME_CHECKOUT ?? 'checkout';
const databaseConfigured = Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD);
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

interface Caller { readonly sub: string; readonly email: string; readonly name: string; }

export interface OrderInput {
  readonly eventId: number;
  readonly quantity: number;
  readonly seatIds?: readonly number[];
}

const app = express();
app.disable('x-powered-by');
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: SERVICE }));

async function authenticate(req: express.Request): Promise<Caller | null> {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !verifier) return null;
  try {
    const claims = await verifier.verify(token);
    const firstName = typeof claims.given_name === 'string' ? claims.given_name : '';
    const lastName = typeof claims.family_name === 'string' ? claims.family_name : '';
    return { sub: String(claims.sub), email: typeof claims.email === 'string' ? claims.email : '', name: `${firstName} ${lastName}`.trim() };
  } catch { return null; }
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseOrderInput(body: unknown): OrderInput | null {
  if (!body || typeof body !== 'object') return null;
  const input = body as { eventId?: unknown; quantity?: unknown; seatIds?: unknown };
  const eventId = positiveInteger(input.eventId);
  const quantity = positiveInteger(input.quantity);
  if (!eventId || !quantity || quantity > 10) return null;
  if (input.seatIds !== undefined && !Array.isArray(input.seatIds)) return null;
  if (Array.isArray(input.seatIds) && input.seatIds.some((seatId) => typeof seatId !== 'number' || !positiveInteger(seatId))) return null;
  return { eventId, quantity, ...(Array.isArray(input.seatIds) ? { seatIds: input.seatIds as number[] } : {}) };
}

export function shouldIssueTickets(orderStatus: string): boolean {
  return orderStatus === 'PENDING' || orderStatus === 'PAID';
}

export function parsePositiveId(value: unknown): number | null {
  return positiveInteger(value);
}

async function issueTickets(orderId: number): Promise<boolean> {
  const response = await fetch(`${TICKET_SERVICE_URL}/internal/orders/${orderId}/issue-tickets`, {
    method: 'POST',
    headers: { 'x-ticket-internal-secret': TICKET_INTERNAL_SHARED_SECRET },
  });
  return response.ok;
}

async function requireCaller(req: express.Request, res: express.Response): Promise<Caller | null> {
  const caller = await authenticate(req);
  if (!caller) res.status(401).json({ error: 'unauthenticated' });
  return caller;
}

async function isEventOrganiser(sub: string, eventId: number): Promise<boolean> {
  const [members] = await database.query<mysql.RowDataPacket[]>(
    "SELECT membership_id FROM event_inventory.event_team_memberships WHERE event_id = ? AND user_sub = ? AND role = 'ORGANISER' AND invite_status = 'ACCEPTED' LIMIT 1",
    [eventId, sub],
  );
  return members.length > 0;
}

async function requireEventOrganiser(req: express.Request, res: express.Response, eventId: number): Promise<Caller | null> {
  const caller = await requireCaller(req, res);
  if (!caller) return null;
  if (!(await isEventOrganiser(caller.sub, eventId))) {
    res.status(403).json({ error: 'event_organiser_required' });
    return null;
  }
  return caller;
}

app.post('/orders', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!databaseConfigured) return res.status(503).json({ error: 'database_not_configured' });
  const input = parseOrderInput(req.body);
  if (!input) {
    return res.status(422).json({ error: 'invalid_order' });
  }
  if (input.seatIds && input.seatIds.length > 0) return res.status(501).json({ error: 'reserved_seating_unavailable' });
  const { eventId, quantity } = input;

  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    const [items] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT e.event_id, e.title, e.status, i.inventory_item_id, i.total_qty, i.reserved_qty,
              i.sold_qty, i.price_cents
         FROM event_inventory.events e
         INNER JOIN event_inventory.inventory_items i
           ON i.event_id = e.event_id AND i.name = 'General Admission'
        WHERE e.event_id = ? FOR UPDATE`, [eventId]);
    const item = items[0];
    if (!item || item.status !== 'PUBLISHED') {
      await connection.rollback();
      return res.status(404).json({ error: 'event_not_found' });
    }
    const remaining = Number(item.total_qty) - Number(item.reserved_qty) - Number(item.sold_qty);
    if (remaining < quantity) {
      await connection.rollback();
      return res.status(409).json({ error: 'insufficient_inventory' });
    }
    await connection.execute('UPDATE event_inventory.inventory_items SET reserved_qty = reserved_qty + ? WHERE inventory_item_id = ?', [quantity, item.inventory_item_id]);
    const [hold] = await connection.execute<mysql.ResultSetHeader>(
      `INSERT INTO event_inventory.inventory_holds
         (event_id, inventory_item_id, customer_sub, quantity, status, expires_at)
       VALUES (?, ?, ?, ?, 'ACTIVE', DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 15 MINUTE))`,
      [eventId, item.inventory_item_id, caller.sub, quantity]);
    const total = Number(item.price_cents) * quantity;
    const [order] = await connection.execute<mysql.ResultSetHeader>(
      `INSERT INTO orders (event_id, customer_sub, customer_email, customer_name, hold_id, status, total_amount_cents)
       VALUES (?, ?, ?, ?, ?, 'PENDING', ?)`, [eventId, caller.sub, caller.email, caller.name, hold.insertId, total]);
    await connection.execute(
      `INSERT INTO order_items (order_id, inventory_item_id, description, quantity, unit_price_cents)
       VALUES (?, ?, ?, ?, ?)`, [order.insertId, item.inventory_item_id, item.title, quantity, item.price_cents]);
    await connection.execute('UPDATE event_inventory.inventory_holds SET order_id = ? WHERE hold_id = ?', [order.insertId, hold.insertId]);
    await connection.commit();
    return res.status(201).json({ order: { order_id: order.insertId, total_amount_cents: total } });
  } catch (error) {
    await connection.rollback();
    console.error('order creation failed', error);
    return res.status(502).json({ error: 'order_creation_failed' });
  } finally { connection.release(); }
});

app.post('/orders/:orderId/payment', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!databaseConfigured) return res.status(503).json({ error: 'database_not_configured' });
  const orderId = positiveInteger(req.params.orderId);
  if (!orderId || typeof req.body?.paymentToken !== 'string' || req.body.paymentToken.length === 0) {
    return res.status(422).json({ error: 'invalid_payment' });
  }
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    const [orders] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT order_id, hold_id, status, total_amount_cents FROM orders WHERE order_id = ? AND customer_sub = ? FOR UPDATE', [orderId, caller.sub]);
    const order = orders[0];
    if (!order) { await connection.rollback(); return res.status(404).json({ error: 'order_not_found' }); }
    if (!shouldIssueTickets(order.status)) {
      await connection.rollback();
      return res.status(409).json({ error: 'order_not_payable' });
    }
    if (order.status === 'PAID') {
      await connection.rollback();
      if (!(await issueTickets(orderId))) return res.status(502).json({ error: 'ticket_issuance_failed' });
      return res.json({ order: { order_id: orderId, status: 'PAID' } });
    }
    const [holds] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT inventory_item_id, quantity, status, expires_at FROM event_inventory.inventory_holds WHERE hold_id = ? FOR UPDATE', [order.hold_id]);
    const hold = holds[0];
    if (!hold || hold.status !== 'ACTIVE' || new Date(hold.expires_at).getTime() <= Date.now()) {
      await connection.rollback();
      return res.status(409).json({ error: 'order_hold_expired' });
    }
    await connection.execute("UPDATE orders SET status = 'PAID', paid_at = CURRENT_TIMESTAMP WHERE order_id = ?", [orderId]);
    await connection.execute("UPDATE event_inventory.inventory_holds SET status = 'CONFIRMED' WHERE hold_id = ?", [order.hold_id]);
    await connection.execute('UPDATE event_inventory.inventory_items SET reserved_qty = reserved_qty - ?, sold_qty = sold_qty + ? WHERE inventory_item_id = ?', [hold.quantity, hold.quantity, hold.inventory_item_id]);
    await connection.commit();
    if (!(await issueTickets(orderId))) {
      console.error('ticket issuance failed after payment', { orderId });
      return res.status(502).json({ error: 'ticket_issuance_failed' });
    }
    return res.json({ order: { order_id: orderId, status: 'PAID', total_amount_cents: order.total_amount_cents } });
  } catch (error) {
    await connection.rollback();
    console.error('payment failed', error);
    return res.status(502).json({ error: 'payment_failed' });
  } finally { connection.release(); }
});

app.get('/orders/:orderId', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  const orderId = parsePositiveId(req.params.orderId);
  if (!orderId) return res.status(400).json({ error: 'invalid_order' });
  try {
    const [orders] = await database.query<mysql.RowDataPacket[]>(
      `SELECT order_id, event_id, customer_email, status, total_amount_cents, currency, created_at, paid_at
         FROM orders WHERE order_id = ? AND customer_sub = ? LIMIT 1`, [orderId, caller.sub]);
    if (!orders[0]) return res.status(404).json({ error: 'order_not_found' });
    const [items] = await database.query<mysql.RowDataPacket[]>(
      'SELECT order_item_id, inventory_item_id, seat_id, description, quantity, unit_price_cents FROM order_items WHERE order_id = ? ORDER BY order_item_id', [orderId]);
    return res.json({ order: { ...orders[0], items } });
  } catch (error) {
    console.error('order lookup failed', error);
    return res.status(502).json({ error: 'order_query_failed' });
  }
});

app.get('/customers/me/orders', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    const [orders] = await database.query<mysql.RowDataPacket[]>(
      `SELECT o.order_id, o.event_id, e.title AS event_title, e.venue, e.starts_at,
              o.customer_email, o.status, o.total_amount_cents, o.currency, o.created_at, o.paid_at
         FROM orders o INNER JOIN event_inventory.events e ON e.event_id = o.event_id
        WHERE o.customer_sub = ? ORDER BY o.created_at DESC`, [caller.sub]);
    return res.json({ orders });
  } catch (error) {
    console.error('customer orders lookup failed', error);
    return res.status(502).json({ error: 'orders_query_failed' });
  }
});

app.get('/sales', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    const [rows] = await database.query<mysql.RowDataPacket[]>(
      `SELECT e.event_id AS eventId, e.title AS event, e.venue,
              COALESCE(SUM(CASE WHEN o.status = 'PAID' THEN oi.quantity ELSE 0 END), 0) AS sold,
              e.total_seats AS capacity,
              COALESCE(SUM(CASE WHEN o.status = 'PAID' THEN o.total_amount_cents ELSE 0 END), 0) / 100 AS revenue,
              CASE WHEN e.total_seats <= COALESCE(SUM(CASE WHEN o.status = 'PAID' THEN oi.quantity ELSE 0 END), 0) THEN 'Sold out'
                   WHEN e.total_seats - COALESCE(SUM(CASE WHEN o.status = 'PAID' THEN oi.quantity ELSE 0 END), 0) < 10 THEN 'Few left'
                   ELSE 'On sale' END AS status
         FROM event_inventory.events e
         INNER JOIN event_inventory.event_team_memberships m ON m.event_id = e.event_id
          AND m.user_sub = ? AND m.role = 'ORGANISER' AND m.invite_status = 'ACCEPTED'
         LEFT JOIN orders o ON o.event_id = e.event_id
         LEFT JOIN order_items oi ON oi.order_id = o.order_id
        GROUP BY e.event_id, e.title, e.venue, e.total_seats ORDER BY e.starts_at`, [caller.sub]);
    return res.json(rows);
  } catch (error) {
    console.error('sales lookup failed', error);
    return res.status(502).json({ error: 'sales_query_failed' });
  }
});

app.get('/attendees', async (req, res) => {
  const eventId = parsePositiveId(req.query.eventId);
  if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  const caller = await requireEventOrganiser(req, res, eventId);
  if (!caller) return;
  try {
    const [rows] = await database.query<mysql.RowDataPacket[]>(
            `SELECT o.customer_email AS email,
              COALESCE(NULLIF(o.customer_name, ''), o.customer_email) AS buyer,
              oi.description AS ticketType, oi.quantity, o.created_at AS orderedAt
         FROM orders o INNER JOIN order_items oi ON oi.order_id = o.order_id
        WHERE o.event_id = ? AND o.status = 'PAID' ORDER BY o.created_at DESC`, [eventId]);
    return res.json(rows);
  } catch (error) {
    console.error('attendees lookup failed', error);
    return res.status(502).json({ error: 'attendees_query_failed' });
  }
});

app.get('/events/:eventId/orders/summary', async (req, res) => {
  const eventId = parsePositiveId(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  const caller = await requireEventOrganiser(req, res, eventId);
  if (!caller) return;
  try {
    const [rows] = await database.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(DISTINCT o.order_id) AS orders,
              COALESCE(SUM(oi.quantity), 0) AS tickets,
              COALESCE(SUM(o.total_amount_cents), 0) AS revenueCents
         FROM orders o INNER JOIN order_items oi ON oi.order_id = o.order_id
        WHERE o.event_id = ? AND o.status = 'PAID'`, [eventId]);
    return res.json({ eventId, ...rows[0] });
  } catch (error) {
    console.error('order summary lookup failed', error);
    return res.status(502).json({ error: 'order_summary_failed' });
  }
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, HOST, () => console.log(`${SERVICE}-service -> http://${HOST}:${PORT}`));
}

export { app };
