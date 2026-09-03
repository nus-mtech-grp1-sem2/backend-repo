import express from 'express';
import type { RowDataPacket } from 'mysql2';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

import { pool } from './db.js';

/**
 * Ticket Issuance & Validation Service.
 *
 * Owns the `ticketing` schema. Tickets themselves are issued by the Checkout
 * & Payment Service (`services/order`) once a payment is captured — this
 * service is the source of truth once a ticket exists: a customer's own
 * tickets, door validation, manual search, and live check-in counts.
 */

const SERVICE = 'ticket';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3005);

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

// -----------------------------------------------------------------------
// GET /customers/me/tickets — the signed-in customer's own issued tickets
// -----------------------------------------------------------------------

interface MyTicketRow extends RowDataPacket {
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

  try {
    const [rows] = await pool.query<MyTicketRow[]>(
      `SELECT
         t.ticket_id, t.event_id, e.title AS event_title, e.venue, e.starts_at,
         s.seat_label, t.qr_token, t.status
       FROM tickets t
       JOIN onestagedb.events e ON e.event_id = t.event_id
       LEFT JOIN onestagedb.seats s ON s.seat_id = t.seat_id
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
  } catch (error) {
    console.error('GET /customers/me/tickets failed', error);
    res.status(500).json({ error: 'tickets_query_failed' });
  }
});

// -----------------------------------------------------------------------
// POST /tickets/validate — scan a QR code at the door
// -----------------------------------------------------------------------

interface TicketByTokenRow extends RowDataPacket {
  ticket_id: number;
  event_id: number;
  status: 'ISSUED' | 'CHECKED_IN' | 'VOID';
}

type ValidateResult = 'SUCCESS' | 'DUPLICATE' | 'INVALID' | 'WRONG_EVENT';

app.post('/tickets/validate', async (req, res) => {
  const caller = await requireAuthenticated(req, res);
  if (!caller) return;

  const eventId = Number(req.body?.eventId);
  const qrToken = typeof req.body?.qrToken === 'string' ? req.body.qrToken.trim() : '';
  if (!Number.isSafeInteger(eventId) || !qrToken) {
    res.status(400).json({ error: 'event_and_token_required' });
    return;
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [tickets] = await connection.query<TicketByTokenRow[]>(
      'SELECT ticket_id, event_id, status FROM tickets WHERE qr_token = ? LIMIT 1 FOR UPDATE',
      [qrToken],
    );
    const ticket = tickets[0];

    let result: ValidateResult;
    if (!ticket) {
      result = 'INVALID';
    } else if (ticket.event_id !== eventId) {
      result = 'WRONG_EVENT';
    } else if (ticket.status === 'CHECKED_IN') {
      result = 'DUPLICATE';
    } else if (ticket.status === 'VOID') {
      result = 'INVALID';
    } else {
      result = 'SUCCESS';
    }

    if (result === 'SUCCESS' && ticket) {
      await connection.query(
        'UPDATE tickets SET status = ?, checked_in_at = NOW(), checked_in_by_sub = ? WHERE ticket_id = ?',
        ['CHECKED_IN', caller.sub, ticket.ticket_id],
      );
    }
    if (ticket) {
      await connection.query(
        'INSERT INTO check_in_logs (ticket_id, scanned_by_sub, result) VALUES (?, ?, ?)',
        [ticket.ticket_id, caller.sub, result],
      );
    }

    await connection.commit();
    res.json({ result });
  } catch (error) {
    await connection.rollback();
    console.error('POST /tickets/validate failed', error);
    res.status(500).json({ error: 'validate_failed' });
  } finally {
    connection.release();
  }
});

// -----------------------------------------------------------------------
// GET /tickets/search?eventId=&query= — manual lookup by name/email/order id
// -----------------------------------------------------------------------

interface TicketSearchRow extends RowDataPacket {
  ticket_id: number;
  customer_email: string;
  seat_label: string | null;
  status: string;
}

app.get('/tickets/search', async (req, res) => {
  const caller = await requireAuthenticated(req, res);
  if (!caller) return;

  const eventId = Number(req.query.eventId);
  const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
  if (!Number.isSafeInteger(eventId) || query.length < 2) {
    res.status(400).json({ error: 'event_and_query_required' });
    return;
  }

  try {
    const like = `%${query}%`;
    const [rows] = await pool.query<TicketSearchRow[]>(
      `SELECT t.ticket_id, t.customer_email, s.seat_label, t.status
       FROM tickets t
       LEFT JOIN onestagedb.seats s ON s.seat_id = t.seat_id
       WHERE t.event_id = ? AND (t.customer_email LIKE ? OR t.order_id LIKE ?)
       ORDER BY t.ticket_id
       LIMIT 20`,
      [eventId, like, like],
    );
    res.json({
      tickets: rows.map((row) => ({
        ticket_id: row.ticket_id,
        customer_email: row.customer_email,
        seat_label: row.seat_label,
        status: row.status,
      })),
    });
  } catch (error) {
    console.error('GET /tickets/search failed', error);
    res.status(500).json({ error: 'ticket_search_failed' });
  }
});

// -----------------------------------------------------------------------
// GET /events/:eventId/checkin-stats — live check-in count for a helper
// -----------------------------------------------------------------------

interface CheckinStatsRow extends RowDataPacket {
  total: number;
  checked_in: number;
}

app.get('/events/:eventId/checkin-stats', async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!Number.isSafeInteger(eventId)) {
    res.status(400).json({ error: 'invalid_event_id' });
    return;
  }

  try {
    const [rows] = await pool.query<CheckinStatsRow[]>(
      `SELECT COUNT(*) AS total, COALESCE(SUM(status = 'CHECKED_IN'), 0) AS checked_in
       FROM tickets WHERE event_id = ? AND status != 'VOID'`,
      [eventId],
    );
    res.json({ total: Number(rows[0]?.total ?? 0), checkedIn: Number(rows[0]?.checked_in ?? 0) });
  } catch (error) {
    console.error('GET /events/:eventId/checkin-stats failed', error);
    res.status(500).json({ error: 'checkin_stats_failed' });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`${SERVICE}-service -> http://${HOST}:${PORT}`);
});
