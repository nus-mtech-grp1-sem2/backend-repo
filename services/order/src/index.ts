import express from 'express';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { randomUUID } from 'node:crypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

import { pool } from './db.js';

/**
 * Checkout & Payment Service (mounted as `order` — see
 * infrastructure/docker-compose.yml / core-frontend's `BackendService` type).
 *
 * Owns the `checkout` schema. There is no separate inventory-hold step yet
 * (see the comment on `inventory_holds` in
 * infrastructure/sql/02-create-all-tables.sql) — `POST /orders` reserves
 * stock and creates the order in one transaction, and `POST
 * /orders/:id/payment` immediately captures a simulated payment and issues
 * tickets. A real payment provider or a two-phase hold can replace either
 * step later without changing the order/ticket shape callers see.
 */

const SERVICE = 'order';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3004);

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? '';
const CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? '';
const configured = USER_POOL_ID.length > 0 && CLIENT_ID.length > 0;
const verifier = configured
  ? CognitoJwtVerifier.create({ userPoolId: USER_POOL_ID, clientId: CLIENT_ID, tokenUse: 'access' })
  : null;

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: SERVICE });
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

interface EventRow extends RowDataPacket {
  status: string;
  tier: 'TIER1_GA' | 'TIER2_SEATED';
}

interface InventoryItemRow extends RowDataPacket {
  inventory_item_id: number;
  name: string;
  total_qty: number;
  reserved_qty: number;
  sold_qty: number;
  price_cents: number;
}

interface SeatRow extends RowDataPacket {
  seat_id: number;
  status: 'AVAILABLE' | 'HELD' | 'SOLD';
}

/**
 * Buy tickets for a published event. Not a two-phase hold: this reserves
 * stock (and, for seated events, the requested seats) and creates the order
 * as `PENDING` in one transaction, so the check for "enough left" and the
 * decrement can never race.
 */
app.post('/orders', async (req, res) => {
  const caller = await requireAuthenticated(req, res);
  if (!caller) return;

  const eventId = Number(req.body?.eventId);
  const quantity = Number(req.body?.quantity);
  const seatIds = Array.isArray(req.body?.seatIds) ? (req.body.seatIds as unknown[]).map(Number) : null;
  const customerEmail = typeof req.body?.customerEmail === 'string' ? req.body.customerEmail.trim() : '';
  if (!Number.isSafeInteger(eventId) || eventId < 1 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20 || !customerEmail) {
    res.status(400).json({ error: 'invalid_order' });
    return;
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [events] = await connection.query<EventRow[]>(
      'SELECT status, tier FROM onestagedb.events WHERE event_id = ? LIMIT 1',
      [eventId],
    );
    const event = events[0];
    if (!event || event.status !== 'PUBLISHED') {
      await connection.rollback();
      res.status(404).json({ error: 'event_not_on_sale' });
      return;
    }

    const [items] = await connection.query<InventoryItemRow[]>(
      'SELECT inventory_item_id, name, total_qty, reserved_qty, sold_qty, price_cents FROM onestagedb.inventory_items WHERE event_id = ? LIMIT 1 FOR UPDATE',
      [eventId],
    );
    const item = items[0];
    if (!item) {
      await connection.rollback();
      res.status(409).json({ error: 'nothing_for_sale' });
      return;
    }
    const remaining = item.total_qty - item.reserved_qty - item.sold_qty;
    if (remaining < quantity) {
      await connection.rollback();
      res.status(409).json({ error: 'insufficient_inventory' });
      return;
    }

    let seats: SeatRow[] = [];
    if (event.tier === 'TIER2_SEATED') {
      if (!seatIds || seatIds.length !== quantity || seatIds.some((id) => !Number.isSafeInteger(id))) {
        await connection.rollback();
        res.status(400).json({ error: 'seat_selection_required' });
        return;
      }
      const [rows] = await connection.query<SeatRow[]>(
        `SELECT seat_id, status FROM onestagedb.seats WHERE event_id = ? AND seat_id IN (${seatIds.map(() => '?').join(',')}) FOR UPDATE`,
        [eventId, ...seatIds],
      );
      seats = rows;
      if (seats.length !== quantity || seats.some((seat) => seat.status !== 'AVAILABLE')) {
        await connection.rollback();
        res.status(409).json({ error: 'seats_unavailable' });
        return;
      }
      await connection.query(
        `UPDATE onestagedb.seats SET status = 'SOLD' WHERE seat_id IN (${seatIds.map(() => '?').join(',')})`,
        seatIds,
      );
    }

    await connection.query('UPDATE onestagedb.inventory_items SET sold_qty = sold_qty + ? WHERE inventory_item_id = ?', [
      quantity,
      item.inventory_item_id,
    ]);

    const totalAmountCents = item.price_cents * quantity;
    const [order] = await connection.query<ResultSetHeader>(
      "INSERT INTO orders (event_id, customer_sub, customer_email, status, total_amount_cents, currency) VALUES (?, ?, ?, 'PENDING', ?, 'SGD')",
      [eventId, caller.sub, customerEmail, totalAmountCents],
    );

    if (event.tier === 'TIER2_SEATED') {
      for (const seat of seats) {
        await connection.query(
          'INSERT INTO order_items (order_id, inventory_item_id, seat_id, description, quantity, unit_price_cents) VALUES (?, ?, ?, ?, 1, ?)',
          [order.insertId, item.inventory_item_id, seat.seat_id, item.name, item.price_cents],
        );
      }
    } else {
      await connection.query(
        'INSERT INTO order_items (order_id, inventory_item_id, seat_id, description, quantity, unit_price_cents) VALUES (?, ?, NULL, ?, ?, ?)',
        [order.insertId, item.inventory_item_id, item.name, quantity, item.price_cents],
      );
    }

    await connection.commit();
    res.status(201).json({ order: { order_id: order.insertId, status: 'PENDING', total_amount_cents: totalAmountCents } });
  } catch (error) {
    await connection.rollback();
    console.error('POST /orders failed', error);
    res.status(500).json({ error: 'order_create_failed' });
  } finally {
    connection.release();
  }
});

interface OrderRow extends RowDataPacket {
  order_id: number;
  event_id: number;
  customer_sub: string;
  customer_email: string;
  status: string;
  total_amount_cents: number;
}

interface OrderItemRow extends RowDataPacket {
  order_item_id: number;
  inventory_item_id: number;
  seat_id: number | null;
  description: string;
  quantity: number;
  unit_price_cents: number;
}

/**
 * Captures a simulated, tokenized payment and issues one ticket per unit
 * bought. No real card data ever reaches this service — `paymentToken` is
 * whatever the client sends and is stored as-is, matching the design doc's
 * "simulated, tokenized payment" checkout model.
 */
app.post('/orders/:orderId/payment', async (req, res) => {
  const caller = await requireAuthenticated(req, res);
  if (!caller) return;

  const orderId = Number(req.params.orderId);
  const paymentToken = typeof req.body?.paymentToken === 'string' ? req.body.paymentToken.trim() : '';
  if (!Number.isSafeInteger(orderId) || orderId < 1 || !paymentToken) {
    res.status(400).json({ error: 'invalid_payment' });
    return;
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [orders] = await connection.query<OrderRow[]>(
      'SELECT order_id, event_id, customer_sub, customer_email, status, total_amount_cents FROM orders WHERE order_id = ? AND customer_sub = ? LIMIT 1 FOR UPDATE',
      [orderId, caller.sub],
    );
    const order = orders[0];
    if (!order) {
      await connection.rollback();
      res.status(404).json({ error: 'order_not_found' });
      return;
    }
    if (order.status !== 'PENDING') {
      await connection.rollback();
      res.status(409).json({ error: 'order_not_payable' });
      return;
    }

    await connection.query(
      "INSERT INTO payments (order_id, payment_token, status, amount_cents) VALUES (?, ?, 'CAPTURED', ?)",
      [orderId, paymentToken, order.total_amount_cents],
    );
    await connection.query("UPDATE orders SET status = 'PAID', paid_at = NOW() WHERE order_id = ?", [orderId]);

    const [items] = await connection.query<OrderItemRow[]>(
      'SELECT order_item_id, inventory_item_id, seat_id, description, quantity, unit_price_cents FROM order_items WHERE order_id = ?',
      [orderId],
    );
    for (const item of items) {
      for (let index = 0; index < item.quantity; index += 1) {
        await connection.query(
          "INSERT INTO ticketing.tickets (order_id, order_item_id, event_id, customer_sub, customer_email, seat_id, qr_token, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'ISSUED')",
          [orderId, item.order_item_id, order.event_id, order.customer_sub, order.customer_email, item.seat_id, randomUUID()],
        );
      }
    }

    await connection.commit();
    res.status(200).json({ status: 'PAID' });
  } catch (error) {
    await connection.rollback();
    console.error('POST /orders/:orderId/payment failed', error);
    res.status(500).json({ error: 'payment_failed' });
  } finally {
    connection.release();
  }
});

// -----------------------------------------------------------------------
// GET /sales — revenue and tickets sold, per event (organiser dashboard)
// -----------------------------------------------------------------------

type EventStatus = 'On sale' | 'Few left' | 'Sold out';

function toStatus(available: number, total: number): EventStatus {
  if (total <= 0 || available <= 0) return 'Sold out';
  if (available / total < 0.15) return 'Few left';
  return 'On sale';
}

interface SalesRow extends RowDataPacket {
  event_id: number;
  event_name: string;
  venue: string;
  sold: number;
  revenue_cents: number;
  total: number | null;
  available: number | null;
}

app.get('/sales', async (_req, res) => {
  try {
    const [rows] = await pool.query<SalesRow[]>(
      `SELECT
         e.event_id, e.title AS event_name, e.venue,
         COALESCE(SUM(oi.quantity), 0) AS sold,
         COALESCE(SUM(oi.quantity * oi.unit_price_cents), 0) AS revenue_cents,
         inv.total_qty AS total,
         inv.total_qty - inv.reserved_qty - inv.sold_qty AS available
       FROM onestagedb.events e
       LEFT JOIN (
         SELECT event_id, SUM(total_qty) AS total_qty, SUM(reserved_qty) AS reserved_qty, SUM(sold_qty) AS sold_qty
         FROM onestagedb.inventory_items GROUP BY event_id
       ) inv ON inv.event_id = e.event_id
       LEFT JOIN orders o ON o.event_id = e.event_id AND o.status = 'PAID'
       LEFT JOIN order_items oi ON oi.order_id = o.order_id
       WHERE e.status != 'CANCELLED'
       GROUP BY e.event_id
       ORDER BY e.starts_at`,
    );

    res.json(
      rows.map((row) => ({
        eventId: row.event_id,
        event: row.event_name,
        venue: row.venue,
        sold: Number(row.sold),
        capacity: Number(row.total ?? 0),
        revenue: Number(row.revenue_cents) / 100,
        status: toStatus(Number(row.available ?? 0), Number(row.total ?? 0)),
      })),
    );
  } catch (error) {
    console.error('GET /sales failed', error);
    res.status(500).json({ error: 'sales_query_failed' });
  }
});

// -----------------------------------------------------------------------
// GET /attendees?eventId= — who bought tickets for one event
// -----------------------------------------------------------------------

interface AttendeeRow extends RowDataPacket {
  customer_email: string;
  description: string;
  quantity: number;
  created_at: Date;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(value: Date): string {
  const weekday = WEEKDAYS[value.getDay()];
  const day = String(value.getDate()).padStart(2, '0');
  const month = MONTHS[value.getMonth()];
  return `${weekday} ${day} ${month} ${value.getFullYear()}`;
}

app.get('/attendees', async (req, res) => {
  const eventId = Number(req.query.eventId);
  if (!Number.isInteger(eventId)) {
    res.status(400).json({ error: 'invalid_event_id' });
    return;
  }

  try {
    const [rows] = await pool.query<AttendeeRow[]>(
      `SELECT o.customer_email, oi.description, SUM(oi.quantity) AS quantity, o.created_at
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.order_id
       WHERE o.event_id = ? AND o.status = 'PAID'
       GROUP BY o.order_id, o.customer_email, oi.description, o.created_at
       ORDER BY o.created_at`,
      [eventId],
    );

    res.json(
      // No local customer profile exists in this schema (identity is the
      // Cognito sub) — the mailbox part of the email stands in for a name.
      rows.map((row) => ({
        buyer: row.customer_email.split('@')[0] ?? row.customer_email,
        email: row.customer_email,
        ticketType: row.description,
        quantity: Number(row.quantity),
        orderedAt: formatDate(row.created_at),
      })),
    );
  } catch (error) {
    console.error('GET /attendees failed', error);
    res.status(500).json({ error: 'attendees_query_failed' });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`${SERVICE}-service -> http://${HOST}:${PORT}`);
});
