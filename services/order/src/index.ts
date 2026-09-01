import express from 'express';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { randomUUID } from 'node:crypto';

import { pool } from './db.js';

const SERVICE = 'order';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3004);

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: SERVICE });
});

interface PurchasableTicketRow extends RowDataPacket {
  ticket_type_id: number;
  event_id: number;
  price: number;
  quantity_available: number;
  max_per_order: number;
  status: string;
}

/**
 * Local checkout: atomically creates a paid order and issued ticket records.
 * A payment provider can replace the immediate paid status later without
 * changing the customer-facing order/ticket model.
 */
app.post('/orders', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const ticketTypeId = Number(req.body?.ticketTypeId);
  const quantity = Number(req.body?.quantity ?? 1);
  if (!email || !Number.isInteger(ticketTypeId) || !Number.isInteger(quantity) || quantity < 1) {
    res.status(400).json({ error: 'invalid_purchase' });
    return;
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [types] = await connection.query<PurchasableTicketRow[]>(
      `SELECT ticket_type_id, event_id, price, quantity_available, max_per_order, status
       FROM ticket_types WHERE ticket_type_id = ? FOR UPDATE`,
      [ticketTypeId],
    );
    const ticketType = types[0];
    if (!ticketType || ticketType.status !== 'active') {
      await connection.rollback(); res.status(404).json({ error: 'ticket_not_on_sale' }); return;
    }
    if (quantity > ticketType.quantity_available || quantity > ticketType.max_per_order) {
      await connection.rollback(); res.status(409).json({ error: 'insufficient_tickets' }); return;
    }

    const [customers] = await connection.query<RowDataPacket[]>('SELECT customer_id FROM customers WHERE email = ?', [email]);
    let customerId = customers[0]?.customer_id as number | undefined;
    if (!customerId) {
      const namePart = email.split('@')[0] || 'customer';
      const displayName = namePart.replace(/[._-]/g, ' ').replace(/\b\w/g, (letter: string) => letter.toUpperCase());
      const [created] = await connection.query<ResultSetHeader>(
        `INSERT INTO customers (customer_name, email, password_hash, first_name, last_name, status, email_verified)
         VALUES (?, ?, 'cognito-managed', ?, '', 'active', TRUE)`,
        [`${namePart}-${Date.now()}`, email, displayName],
      );
      customerId = created.insertId;
    }

    const total = Number(ticketType.price) * quantity;
    const orderNumber = `ONE-${Date.now()}-${randomUUID().slice(0, 6).toUpperCase()}`;
    const [order] = await connection.query<ResultSetHeader>(
      `INSERT INTO orders
       (order_number, customer_id, event_id, order_status, payment_status, total_amount,
        final_amount, currency, billing_email, payment_method, confirmed_at, completed_at)
       VALUES (?, ?, ?, 'completed', 'paid', ?, ?, 'SGD', ?, 'local-demo', NOW(), NOW())`,
      [orderNumber, customerId, ticketType.event_id, total, total, email],
    );

    const ticketIds: number[] = [];
    for (let index = 0; index < quantity; index += 1) {
      const publicId = randomUUID();
      const [ticket] = await connection.query<ResultSetHeader>(
        `INSERT INTO tickets
         (ticket_uuid, event_id, ticket_type_id, order_id, customer_id, ticket_code, status, price_paid, issued_at)
         VALUES (?, ?, ?, ?, ?, ?, 'sold', ?, NOW())`,
        [publicId, ticketType.event_id, ticketTypeId, order.insertId, customerId,
         `TKT-${publicId.slice(0, 8).toUpperCase()}`, ticketType.price],
      );
      ticketIds.push(ticket.insertId);
    }
    await connection.query(
      `INSERT INTO order_items (order_id, ticket_type_id, ticket_id, quantity, unit_price, subtotal)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [order.insertId, ticketTypeId, ticketIds[0], quantity, ticketType.price, total],
    );
    await connection.query(
      `UPDATE ticket_types SET status = IF(quantity_available = ?, 'sold_out', status),
       quantity_available = quantity_available - ?, quantity_sold = quantity_sold + ? WHERE ticket_type_id = ?`,
      [quantity, quantity, quantity, ticketTypeId],
    );
    await connection.query(
      `INSERT IGNORE INTO customer_event_roles (customer_id, event_id, role_id) VALUES (?, ?, 2)`,
      [customerId, ticketType.event_id],
    );
    await connection.commit();
    res.status(201).json({ orderId: order.insertId, reference: orderNumber, eventId: ticketType.event_id, quantity });
  } catch (error) {
    await connection.rollback();
    console.error('POST /orders failed', error);
    res.status(500).json({ error: 'purchase_failed' });
  } finally {
    connection.release();
  }
});

interface CancellationItemRow extends RowDataPacket {
  ticket_type_id: number;
  quantity: number;
}

/** Cancel one customer's paid order and return its tickets to inventory. */
app.delete('/orders/:reference', async (req, res) => {
  const reference = req.params.reference;
  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  if (!reference || !email) { res.status(400).json({ error: 'reference_and_email_required' }); return; }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [orders] = await connection.query<RowDataPacket[]>(
      `SELECT o.order_id, o.customer_id, o.event_id, o.payment_status
       FROM orders o JOIN customers c ON c.customer_id = o.customer_id
       WHERE o.order_number = ? AND c.email = ? FOR UPDATE`,
      [reference, email],
    );
    const order = orders[0];
    if (!order) { await connection.rollback(); res.status(404).json({ error: 'order_not_found' }); return; }
    if (order.payment_status !== 'paid') { await connection.rollback(); res.status(409).json({ error: 'order_not_cancellable' }); return; }

    const [items] = await connection.query<CancellationItemRow[]>(
      `SELECT ticket_type_id, SUM(quantity) AS quantity FROM order_items WHERE order_id = ? GROUP BY ticket_type_id`,
      [order.order_id],
    );
    for (const item of items) {
      await connection.query(
        `UPDATE ticket_types SET quantity_available = LEAST(quantity_total, quantity_available + ?),
         quantity_sold = GREATEST(0, quantity_sold - ?), status = 'active' WHERE ticket_type_id = ?`,
        [item.quantity, item.quantity, item.ticket_type_id],
      );
    }
    await connection.query(`UPDATE tickets SET status = 'cancelled' WHERE order_id = ? AND status IN ('sold', 'used')`, [order.order_id]);
    await connection.query(
      `UPDATE orders SET order_status = 'cancelled', payment_status = 'refunded' WHERE order_id = ?`, [order.order_id],
    );
    await connection.query(
      `INSERT INTO order_history (order_id, status_from, status_to, changed_by_customer_id, reason)
       VALUES (?, 'completed', 'cancelled', ?, 'Customer cancellation')`,
      [order.order_id, order.customer_id],
    );
    const [remaining] = await connection.query<RowDataPacket[]>(
      `SELECT 1 FROM orders WHERE customer_id = ? AND event_id = ? AND payment_status = 'paid' LIMIT 1`,
      [order.customer_id, order.event_id],
    );
    if (!remaining[0]) {
      await connection.query(
        `DELETE FROM customer_event_roles WHERE customer_id = ? AND event_id = ? AND role_id = 2`,
        [order.customer_id, order.event_id],
      );
    }
    await connection.commit();
    res.status(204).send();
  } catch (error) {
    await connection.rollback();
    console.error('DELETE /orders/:reference failed', error);
    res.status(500).json({ error: 'order_cancel_failed' });
  } finally { connection.release(); }
});

type EventStatus = 'On sale' | 'Few left' | 'Sold out';

function toStatus(available: number, total: number): EventStatus {
  if (total <= 0 || available <= 0) {
    return 'Sold out';
  }
  if (available / total < 0.15) {
    return 'Few left';
  }
  return 'On sale';
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** See the event service's `formatDate` for why this is hand-rolled rather than locale-based. */
function formatDate(value: Date): string {
  const day = String(value.getDate()).padStart(2, '0');
  const month = MONTHS[value.getMonth()];
  return `${day} ${month} ${value.getFullYear()}`;
}

function formatTime(value: Date): string {
  const hours24 = value.getHours();
  const minutes = String(value.getMinutes()).padStart(2, '0');
  const period = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 || 12;
  return `${hours12}:${minutes} ${period}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Full weekday-qualified date, for a customer's own order history. */
function formatEventDate(value: Date): string {
  const weekday = WEEKDAYS[value.getDay()];
  const day = String(value.getDate()).padStart(2, '0');
  const month = MONTHS[value.getMonth()];
  return `${weekday} ${day} ${month} ${value.getFullYear()}`;
}

// -----------------------------------------------------------------------
// GET /sales — revenue and tickets sold, per event
// -----------------------------------------------------------------------

interface SalesRow extends RowDataPacket {
  event_id: number;
  event_name: string;
  venue_name: string;
  sold: number;
  revenue: number;
  available: number | null;
  total: number | null;
}

app.get('/sales', async (_req, res) => {
  try {
    const [rows] = await pool.query<SalesRow[]>(
      `SELECT
         e.event_id, e.event_name, v.venue_name,
         COALESCE(SUM(oi.quantity), 0) AS sold,
         COALESCE(SUM(oi.subtotal), 0) AS revenue,
         (SELECT COALESCE(SUM(quantity_available), 0) FROM ticket_types WHERE event_id = e.event_id) AS available,
         (SELECT COALESCE(SUM(quantity_total), 0) FROM ticket_types WHERE event_id = e.event_id) AS total
       FROM events e
       JOIN venues v ON v.venue_id = e.venue_id
       LEFT JOIN orders o ON o.event_id = e.event_id AND o.payment_status = 'paid'
       LEFT JOIN order_items oi ON oi.order_id = o.order_id
       WHERE e.status != 'cancelled'
       GROUP BY e.event_id
       ORDER BY e.event_start_datetime`,
    );

    res.json(
      rows.map((row) => ({
        eventId: row.event_id,
        event: row.event_name,
        venue: row.venue_name,
        sold: Number(row.sold),
        capacity: Number(row.total ?? 0),
        revenue: Number(row.revenue),
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
  first_name: string;
  last_name: string;
  email: string;
  type_name: string;
  seating_section: string | null;
  quantity: number;
  created_at: Date;
}

app.get('/attendees', async (req, res) => {
  const eventId = Number(req.query.eventId);
  if (!Number.isInteger(eventId)) {
    res.status(400).json({ error: 'invalid_event_id' });
    return;
  }

  try {
    const [rows] = await pool.query<AttendeeRow[]>(
      `SELECT
         c.first_name, c.last_name, c.email,
         tt.type_name, tt.seating_section, oi.quantity, o.created_at
       FROM order_items oi
       JOIN orders o ON o.order_id = oi.order_id
       JOIN customers c ON c.customer_id = o.customer_id
       JOIN ticket_types tt ON tt.ticket_type_id = oi.ticket_type_id
       WHERE o.event_id = ? AND o.payment_status = 'paid'
       ORDER BY o.created_at`,
      [eventId],
    );

    res.json(
      rows.map((row) => ({
        buyer: `${row.first_name} ${row.last_name}`.trim(),
        email: row.email,
        ticketType: row.seating_section ?? row.type_name,
        quantity: row.quantity,
        orderedAt: formatDate(row.created_at),
      })),
    );
  } catch (error) {
    console.error('GET /attendees failed', error);
    res.status(500).json({ error: 'attendees_query_failed' });
  }
});

// -----------------------------------------------------------------------
// GET /orders?email= — a signed-in customer's own paid orders
// -----------------------------------------------------------------------

interface CustomerOrderRow extends RowDataPacket {
  event_id: number;
  order_number: string;
  event_name: string;
  venue_name: string;
  event_start_datetime: Date;
  seats: string | null;
  quantity: number;
}

app.get('/orders', async (req, res) => {
  const email = typeof req.query.email === 'string' ? req.query.email.trim() : '';
  if (!email) {
    res.status(400).json({ error: 'email_required' });
    return;
  }

  try {
    const [rows] = await pool.query<CustomerOrderRow[]>(
      `SELECT
         o.order_number, e.event_id, e.event_name, v.venue_name, e.event_start_datetime,
         GROUP_CONCAT(DISTINCT COALESCE(tt.seating_section, tt.type_name) SEPARATOR ', ') AS seats,
         SUM(oi.quantity) AS quantity
       FROM orders o
       JOIN customers c ON c.customer_id = o.customer_id
       JOIN events e ON e.event_id = o.event_id
       JOIN venues v ON v.venue_id = e.venue_id
       JOIN order_items oi ON oi.order_id = o.order_id
       JOIN ticket_types tt ON tt.ticket_type_id = oi.ticket_type_id
       WHERE c.email = ? AND o.payment_status = 'paid'
       GROUP BY o.order_id
       ORDER BY e.event_start_datetime DESC`,
      [email],
    );

    res.json(
      rows.map((row) => ({
        eventId: row.event_id,
        reference: row.order_number,
        event: row.event_name,
        venue: row.venue_name,
        date: formatEventDate(row.event_start_datetime),
        time: formatTime(row.event_start_datetime),
        seats: row.seats ?? '',
        quantity: Number(row.quantity),
      })),
    );
  } catch (error) {
    console.error('GET /orders failed', error);
    res.status(500).json({ error: 'orders_query_failed' });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`${SERVICE}-service -> http://${HOST}:${PORT}`);
});
