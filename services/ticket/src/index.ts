import express from 'express';
import type { RowDataPacket } from 'mysql2';

import { pool } from './db.js';

const SERVICE = 'ticket';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3005);

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: SERVICE });
});

type EventCategory = 'Concerts' | 'Sports' | 'Theatre';

function toCategory(eventType: string): EventCategory {
  switch (eventType) {
    case 'sports':
      return 'Sports';
    case 'theater':
      return 'Theatre';
    default:
      return 'Concerts';
  }
}

type TicketStatus = 'On sale' | 'Few left' | 'Sold out';

function toStatus(available: number, total: number): TicketStatus {
  if (total <= 0 || available <= 0) {
    return 'Sold out';
  }
  if (available / total < 0.15) {
    return 'Few left';
  }
  return 'On sale';
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Hand-formats rather than using `toLocaleDateString`: ICU output for the
 * same locale differs between Node builds (a comma after the weekday, "Sept"
 * vs "Sep"), which would make the API's wording depend on which image it
 * runs in. MySQL returns these datetimes already in the server's local time,
 * so no timezone conversion happens here.
 */
function formatDate(value: Date): string {
  const weekday = WEEKDAYS[value.getDay()];
  const day = String(value.getDate()).padStart(2, '0');
  const month = MONTHS[value.getMonth()];
  return `${weekday} ${day} ${month} ${value.getFullYear()}`;
}

function formatTime(value: Date): string {
  const hours24 = value.getHours();
  const minutes = String(value.getMinutes()).padStart(2, '0');
  const period = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 || 12;
  return `${hours12}:${minutes} ${period}`;
}

interface TicketListingRow extends RowDataPacket {
  ticket_type_id: number;
  event_id: number;
  event_name: string;
  event_type: string;
  venue_name: string;
  event_start_datetime: Date;
  seating_section: string | null;
  type_name: string;
  price: number;
  quantity_available: number;
  quantity_total: number;
}

// -----------------------------------------------------------------------
// GET /tickets — every ticket type currently on sale, across every event.
// Each row is one "listing" (a section/price combination), matching the
// shape `core-frontend`'s Tickets page renders one row per.
// -----------------------------------------------------------------------

app.get('/tickets', async (_req, res) => {
  try {
    const [rows] = await pool.query<TicketListingRow[]>(
      `SELECT
         tt.ticket_type_id, tt.event_id, e.event_name, e.event_type,
         v.venue_name, e.event_start_datetime,
         tt.seating_section, tt.type_name, tt.price,
         tt.quantity_available, tt.quantity_total
       FROM ticket_types tt
       JOIN events e ON e.event_id = tt.event_id
       JOIN venues v ON v.venue_id = e.venue_id
       WHERE e.status != 'cancelled' AND tt.status != 'inactive'
       ORDER BY e.event_start_datetime, tt.ticket_type_id`,
    );

    res.json(
      rows.map((row) => ({
        id: `TT-${row.ticket_type_id}`,
        eventId: row.event_id,
        event: row.event_name,
        category: toCategory(row.event_type),
        venue: row.venue_name,
        date: formatDate(row.event_start_datetime),
        time: formatTime(row.event_start_datetime),
        section: row.seating_section ?? row.type_name,
        price: Number(row.price),
        status: toStatus(row.quantity_available, row.quantity_total),
      })),
    );
  } catch (error) {
    console.error('GET /tickets failed', error);
    res.status(500).json({ error: 'tickets_query_failed' });
  }
});

interface CheckInRow extends RowDataPacket {
  ticket_id: number;
  event_id: number;
  status: string;
  customer_id: number | null;
}

interface TicketSearchRow extends RowDataPacket {
  ticket_id: number;
  ticket_code: string;
  customer_name: string;
  customer_email: string;
  order_number: string;
  status: string;
}

interface CheckInStatsRow extends RowDataPacket {
  sold: number;
  checked_in: number;
}

/** Validate and persist a manual door scan. */
app.post('/events/:eventId/check-ins', async (req, res) => {
  const eventId = Number(req.params.eventId);
  const code = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : '';
  const helperEmail = typeof req.body?.helperEmail === 'string' ? req.body.helperEmail.trim() : '';
  if (!Number.isInteger(eventId) || !code || !helperEmail) {
    res.status(400).json({ error: 'code_and_helper_required' });
    return;
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [tickets] = await connection.query<CheckInRow[]>(
      'SELECT ticket_id, event_id, status, customer_id FROM tickets WHERE ticket_code = ? FOR UPDATE', [code],
    );
    const ticket = tickets[0];
    if (!ticket) {
      await connection.rollback();
      res.status(404).json({ code, outcome: 'unknown', at: new Date().toISOString() });
      return;
    }
    if (ticket.event_id !== eventId) {
      await connection.rollback();
      res.status(200).json({ code, outcome: 'wrong_event', at: new Date().toISOString() });
      return;
    }
    const [helpers] = await connection.query<RowDataPacket[]>(
      `SELECT c.customer_id FROM customers c
       JOIN customer_event_roles cer ON cer.customer_id = c.customer_id
       WHERE c.email = ? AND cer.event_id = ? AND cer.role_id IN (1, 3)
         AND cer.status = 'ACTIVE'`,
      [helperEmail, ticket.event_id],
    );
    if (!helpers[0]) {
      await connection.rollback();
      res.status(403).json({ error: 'not_event_staff' });
      return;
    }
    const now = new Date();
    const outcome = ticket.status === 'used' ? 'duplicate' : ticket.status === 'sold' ? 'admitted' : 'unknown';
    if (outcome === 'admitted') {
      await connection.query(
        `UPDATE tickets SET status = 'used', used_at = ?, checked_in_at = ?, checked_in_by_customer_id = ?
         WHERE ticket_id = ?`,
        [now, now, helpers[0].customer_id, ticket.ticket_id],
      );
    }
    await connection.query(
      `INSERT INTO ticket_check_in_history
       (ticket_id, event_id, customer_id, checked_in_by_customer_id, check_in_method, status, failure_reason)
       VALUES (?, ?, ?, ?, 'manual', ?, ?)`,
      [ticket.ticket_id, ticket.event_id, ticket.customer_id, helpers[0].customer_id,
       outcome === 'admitted' ? 'success' : outcome, outcome === 'admitted' ? null : outcome],
    );
    await connection.commit();
    res.status(outcome === 'admitted' ? 201 : 200).json({ code, outcome, at: now.toISOString() });
  } catch (error) {
    await connection.rollback();
    console.error('POST /check-ins failed', error);
    res.status(500).json({ error: 'check_in_failed' });
  } finally {
    connection.release();
  }
});

app.get('/events/:eventId/tickets/search', async (req, res) => {
  const eventId = Number(req.params.eventId);
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!Number.isInteger(eventId) || query.length < 2) {
    res.status(400).json({ error: 'event_and_query_required' });
    return;
  }

  try {
    const like = `%${query}%`;
    const [rows] = await pool.query<TicketSearchRow[]>(
      `SELECT t.ticket_id, t.ticket_code, c.customer_name, c.email AS customer_email,
              o.order_number, t.status
       FROM tickets t
       LEFT JOIN customers c ON c.customer_id = t.customer_id
       LEFT JOIN orders o ON o.order_id = t.order_id
       WHERE t.event_id = ?
         AND (t.ticket_code LIKE ? OR c.customer_name LIKE ? OR c.email LIKE ? OR o.order_number LIKE ?)
       ORDER BY t.ticket_id
       LIMIT 20`,
      [eventId, like, like, like, like],
    );
    res.json(rows.map((row) => ({
      ticketId: row.ticket_id,
      code: row.ticket_code,
      name: row.customer_name,
      email: row.customer_email,
      orderNumber: row.order_number,
      status: row.status,
    })));
  } catch (error) {
    console.error('GET /events/:eventId/tickets/search failed', error);
    res.status(500).json({ error: 'ticket_search_failed' });
  }
});

app.get('/events/:eventId/check-in-stats', async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!Number.isInteger(eventId)) {
    res.status(400).json({ error: 'invalid_event_id' });
    return;
  }
  try {
    const [rows] = await pool.query<CheckInStatsRow[]>(
      `SELECT
         COALESCE(SUM(status IN ('sold', 'used')), 0) AS sold,
         COALESCE(SUM(status = 'used'), 0) AS checked_in
       FROM tickets WHERE event_id = ?`,
      [eventId],
    );
    res.json({ sold: Number(rows[0]?.sold ?? 0), checkedIn: Number(rows[0]?.checked_in ?? 0) });
  } catch (error) {
    console.error('GET /events/:eventId/check-in-stats failed', error);
    res.status(500).json({ error: 'check_in_stats_failed' });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`${SERVICE}-service -> http://${HOST}:${PORT}`);
});
