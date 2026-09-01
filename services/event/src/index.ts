import express from 'express';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

import { pool } from './db.js';

const SERVICE = 'event';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3001);

const app = express();
app.use(express.json({ limit: '6mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: SERVICE });
});

// -----------------------------------------------------------------------
// Shape helpers
// -----------------------------------------------------------------------

/** The three categories `core-frontend` knows about; anything else collapses to Concerts. */
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

type EventStatus = 'On sale' | 'Few left' | 'Sold out';

/** Same three-tier read the organiser dashboard mock used to hand-pick. */
function toStatus(available: number, total: number): EventStatus {
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

interface EventRow extends RowDataPacket {
  event_id: number;
  event_name: string;
  event_description: string | null;
  event_type: string;
  venue_id: number;
  venue_name: string;
  address: string | null;
  city: string | null;
  country: string | null;
  postal_code: string | null;
  venue_capacity: number | null;
  event_start_datetime: Date;
  event_end_datetime: Date;
  banner_image_url: string | null;
  featured: number;
  price_from: number | null;
  available: number | null;
  total: number | null;
  has_image: number;
}

const DEFAULT_EVENT_ART: Record<EventCategory, string> = {
  Concerts: 'images/hero-concert.jpg', Sports: 'images/hero-stadium.jpg', Theatre: 'images/hero-theatre.jpg',
};

function toEventListing(row: EventRow) {
  return {
    id: row.event_id,
    title: row.event_name,
    description: row.event_description ?? '',
    category: toCategory(row.event_type),
    venueId: row.venue_id,
    venue: row.venue_name,
    date: formatDate(row.event_start_datetime),
    time: formatTime(row.event_start_datetime),
    featured: Boolean(row.featured),
    priceFrom: Number(row.price_from ?? 0),
    image: row.has_image ? `/api/event/events/${row.event_id}/image` : (row.banner_image_url ?? DEFAULT_EVENT_ART[toCategory(row.event_type)]),
    alt: `${row.event_name} at ${row.venue_name}`,
    status: toStatus(Number(row.available ?? 0), Number(row.total ?? 0)),
  };
}

/** `extraWhere` is appended before GROUP BY — pass a fragment like `AND e.event_id = ?`. */
function eventListingSql(extraWhere = ''): string {
  return `
    SELECT
      e.event_id, e.event_name, e.event_description, e.event_type, e.featured,
      v.venue_id, v.venue_name, v.address, v.city, v.country, v.postal_code,
      v.capacity AS venue_capacity, e.event_start_datetime, e.event_end_datetime,
      e.banner_image_url,
      EXISTS(SELECT 1 FROM event_images ei WHERE ei.event_id = e.event_id) AS has_image,
      MIN(tt.price) AS price_from,
      COALESCE(SUM(tt.quantity_available), 0) AS available,
      COALESCE(SUM(tt.quantity_total), 0) AS total
    FROM events e
    JOIN venues v ON v.venue_id = e.venue_id
    LEFT JOIN ticket_types tt ON tt.event_id = e.event_id AND tt.status != 'inactive'
    WHERE e.status != 'cancelled'
    ${extraWhere}
    GROUP BY e.event_id
  `;
}

// -----------------------------------------------------------------------
// GET /events — the storefront listing and the organiser dashboard table
// -----------------------------------------------------------------------

app.get('/events', async (req, res) => {
  try {
    const organizerEmail = typeof req.query.organizerEmail === 'string' ? req.query.organizerEmail.trim() : '';
    const filter = organizerEmail
      ? 'AND e.organizer_id = (SELECT customer_id FROM customers WHERE email = ?)'
      : '';
    const [rows] = await pool.query<EventRow[]>(`${eventListingSql(filter)} ORDER BY e.event_start_datetime`,
      organizerEmail ? [organizerEmail] : []);
    res.json(rows.map(toEventListing));
  } catch (error) {
    console.error('GET /events failed', error);
    res.status(500).json({ error: 'events_query_failed' });
  }
});

/** Soft-cancel an event, restricted to the customer who originally created it. */
app.delete('/events/:id', async (req, res) => {
  const eventId = Number(req.params.id);
  const organizerEmail = typeof req.query.organizerEmail === 'string' ? req.query.organizerEmail.trim() : '';
  if (!Number.isInteger(eventId) || !organizerEmail) { res.status(400).json({ error: 'event_and_organizer_required' }); return; }
  try {
    const [result] = await pool.query<ResultSetHeader>(
      `UPDATE events e JOIN customers c ON c.customer_id = e.organizer_id
       SET e.status = 'cancelled', e.cancellation_reason = 'Cancelled by organiser'
       WHERE e.event_id = ? AND c.email = ? AND e.status != 'cancelled'`,
      [eventId, organizerEmail],
    );
    if (result.affectedRows === 0) { res.status(404).json({ error: 'owned_event_not_found' }); return; }
    res.status(204).send();
  } catch (error) {
    console.error('DELETE /events/:id failed', error);
    res.status(500).json({ error: 'event_cancel_failed' });
  }
});

// -----------------------------------------------------------------------
// GET /events/:id — one event plus its ticket types, for the detail,
// update-event and event-team pages
// -----------------------------------------------------------------------

interface TicketTypeRow extends RowDataPacket {
  ticket_type_id: number;
  type_name: string;
  seating_section: string | null;
  price: number;
  quantity_available: number;
  quantity_total: number;
}

app.get('/events/:id', async (req, res) => {
  const eventId = Number(req.params.id);
  if (!Number.isInteger(eventId)) {
    res.status(400).json({ error: 'invalid_event_id' });
    return;
  }

  try {
    const [eventRows] = await pool.query<EventRow[]>(eventListingSql('AND e.event_id = ?'), [eventId]);
    const eventRow = eventRows[0];
    if (!eventRow) {
      res.status(404).json({ error: 'event_not_found' });
      return;
    }

    const [ticketRows] = await pool.query<TicketTypeRow[]>(
      `SELECT ticket_type_id, type_name, seating_section, price, quantity_available, quantity_total
       FROM ticket_types WHERE event_id = ? AND status != 'inactive' ORDER BY ticket_type_id`,
      [eventId],
    );

    res.json({
      ...toEventListing(eventRow),
      eventType: eventRow.event_type,
      startDateTime: eventRow.event_start_datetime,
      endDateTime: eventRow.event_end_datetime,
      venueDetails: {
        id: eventRow.venue_id, name: eventRow.venue_name, address: eventRow.address ?? '',
        city: eventRow.city ?? '', country: eventRow.country ?? '', postalCode: eventRow.postal_code ?? '',
        capacity: eventRow.venue_capacity ?? 0,
      },
      ticketTypes: ticketRows.map((ticket) => ({
        id: `TT-${ticket.ticket_type_id}`,
        name: ticket.type_name,
        section: ticket.seating_section ?? ticket.type_name,
        price: Number(ticket.price),
        quantity: ticket.quantity_total,
        status: toStatus(ticket.quantity_available, ticket.quantity_total),
      })),
    });
  } catch (error) {
    console.error('GET /events/:id failed', error);
    res.status(500).json({ error: 'event_query_failed' });
  }
});

interface EventImageRow extends RowDataPacket { mime_type: string; image_data: Buffer }

app.get('/events/:id/image', async (req, res) => {
  const eventId = Number(req.params.id);
  if (!Number.isInteger(eventId)) { res.status(400).json({ error: 'invalid_event_id' }); return; }
  try {
    const [rows] = await pool.query<EventImageRow[]>('SELECT mime_type, image_data FROM event_images WHERE event_id = ?', [eventId]);
    const image = rows[0];
    if (!image) { res.status(404).json({ error: 'image_not_found' }); return; }
    res.setHeader('Content-Type', image.mime_type);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(image.image_data);
  } catch (error) {
    console.error('GET /events/:id/image failed', error);
    res.status(500).json({ error: 'image_query_failed' });
  }
});

// -----------------------------------------------------------------------
// GET /venues — every venue organisers have used, for the storefront
// -----------------------------------------------------------------------

/** Comma-groups a whole number without relying on locale/ICU formatting. */
function formatThousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** No venue photo is captured yet — fall back deterministically by venue type. */
const DEFAULT_VENUE_ART = { image: 'images/venue-arena.jpg', alt: 'Indoor arena crowd facing a lit stage' };
const VENUE_TYPE_IMAGES: Record<string, { image: string; alt: string }> = {
  outdoor: { image: 'images/venue-openair.jpg', alt: 'Open-air venue crowd under stage lights' },
  virtual: { image: 'images/venue-livehouse.jpg', alt: 'Live house stage set up for a virtual broadcast' },
  hybrid: { image: 'images/venue-festival.jpg', alt: 'Festival grounds set up for a hybrid event' },
  indoor: DEFAULT_VENUE_ART,
};

interface VenueRow extends RowDataPacket {
  venue_id: number;
  venue_name: string;
  city: string | null;
  capacity: number | null;
  venue_type: string;
  upcoming: number;
}

app.get('/venues', async (_req, res) => {
  try {
    const [rows] = await pool.query<VenueRow[]>(
      `SELECT v.venue_id, v.venue_name, v.city, v.capacity, v.venue_type,
         COUNT(CASE WHEN e.status = 'published' AND e.event_start_datetime >= NOW() THEN 1 END) AS upcoming
       FROM venues v
       LEFT JOIN events e ON e.venue_id = v.venue_id
       GROUP BY v.venue_id
       ORDER BY v.venue_name`,
    );

    res.json(
      rows.map((row) => {
        const art = VENUE_TYPE_IMAGES[row.venue_type] ?? DEFAULT_VENUE_ART;
        return {
          id: row.venue_id,
          name: row.venue_name,
          city: row.city ?? '',
          capacity: row.capacity ? `${formatThousands(row.capacity)} capacity` : 'Capacity not set',
          upcoming: Number(row.upcoming),
          image: art.image,
          alt: art.alt,
        };
      }),
    );
  } catch (error) {
    console.error('GET /venues failed', error);
    res.status(500).json({ error: 'venues_query_failed' });
  }
});

// -----------------------------------------------------------------------
// Creating and editing events: shared venue/ticket handling
// -----------------------------------------------------------------------

interface VenueInput {
  id?: number;
  name?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  capacity?: number;
  venueType?: string;
}

const VENUE_TYPES = new Set(['indoor', 'outdoor', 'virtual', 'hybrid']);

/** Reuses a venue by id or by (case-insensitive) name, else creates one from the details given. */
async function resolveVenue(venue: VenueInput | undefined): Promise<number> {
  if (venue?.id) {
    const [rows] = await pool.query<RowDataPacket[]>('SELECT venue_id FROM venues WHERE venue_id = ?', [venue.id]);
    if (rows[0]) {
      const venueType = VENUE_TYPES.has(venue.venueType ?? '') ? venue.venueType : 'indoor';
      await pool.query(
        `UPDATE venues SET venue_name = ?, address = ?, city = ?, state = ?, country = ?,
         postal_code = ?, capacity = ?, venue_type = ? WHERE venue_id = ?`,
        [venue.name?.trim(), venue.address || null, venue.city || null, venue.state || null,
         venue.country || null, venue.postalCode || null, venue.capacity || null, venueType, venue.id],
      );
      return rows[0].venue_id as number;
    }
  }

  const name = venue?.name?.trim();
  if (!name) {
    throw new Error('venue_name_required');
  }

  const [existing] = await pool.query<RowDataPacket[]>(
    'SELECT venue_id FROM venues WHERE LOWER(venue_name) = LOWER(?)',
    [name],
  );
  if (existing[0]) {
    return existing[0].venue_id as number;
  }

  const venueType = VENUE_TYPES.has(venue?.venueType ?? '') ? venue!.venueType : 'indoor';
  const [result] = await pool.query(
    `INSERT INTO venues (venue_name, address, city, state, country, postal_code, capacity, venue_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      venue?.address || null,
      venue?.city || null,
      venue?.state || null,
      venue?.country || null,
      venue?.postalCode || null,
      venue?.capacity || null,
      venueType,
    ],
  );

  return (result as { insertId: number }).insertId;
}

const EVENT_TYPES = new Set(['concert', 'sports', 'theater', 'conference', 'festival', 'other']);

interface TicketInput {
  id?: string;
  name?: string;
  section?: string;
  price?: number;
  quantity?: number;
}

interface EventFormBody {
  organizerEmail?: string;
  name?: string;
  description?: string;
  eventType?: string;
  startDateTime?: string;
  endDateTime?: string;
  featured?: boolean;
  venue?: VenueInput;
  tickets?: TicketInput[];
  image?: { mimeType?: string; data?: string };
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
async function saveEventImage(eventId: number, image: EventFormBody['image']): Promise<void> {
  if (!image?.data || !image.mimeType || !IMAGE_TYPES.has(image.mimeType)) return;
  const data = Buffer.from(image.data, 'base64');
  if (data.length === 0 || data.length > 4 * 1024 * 1024) throw new Error('invalid_image_size');
  await pool.query(
    `INSERT INTO event_images (event_id, mime_type, image_data) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE mime_type = VALUES(mime_type), image_data = VALUES(image_data)`,
    [eventId, image.mimeType, data],
  );
}

function validEventForm(body: EventFormBody): string | null {
  if (!body.name?.trim()) return 'name_required';
  if (!body.startDateTime || Number.isNaN(Date.parse(body.startDateTime))) return 'invalid_start';
  if (!body.endDateTime || Number.isNaN(Date.parse(body.endDateTime))) return 'invalid_end';
  if (!body.venue?.name?.trim()) return 'venue_name_required';
  if (!Array.isArray(body.tickets) || body.tickets.length === 0) return 'tickets_required';
  for (const ticket of body.tickets) {
    if (!ticket.name?.trim()) return 'ticket_name_required';
    if (!Number.isFinite(ticket.price) || (ticket.price as number) < 0) return 'invalid_ticket_price';
    if (!Number.isInteger(ticket.quantity) || (ticket.quantity as number) <= 0) return 'invalid_ticket_quantity';
  }
  return null;
}

async function respondWithEvent(res: express.Response, eventId: number, status: number): Promise<void> {
  const [eventRows] = await pool.query<EventRow[]>(eventListingSql('AND e.event_id = ?'), [eventId]);
  const eventRow = eventRows[0];
  if (!eventRow) {
    res.status(404).json({ error: 'event_not_found' });
    return;
  }

  const [ticketRows] = await pool.query<TicketTypeRow[]>(
    `SELECT ticket_type_id, type_name, seating_section, price, quantity_available, quantity_total
     FROM ticket_types WHERE event_id = ? AND status != 'inactive' ORDER BY ticket_type_id`,
    [eventId],
  );

  res.status(status).json({
    ...toEventListing(eventRow),
    ticketTypes: ticketRows.map((ticket) => ({
      id: `TT-${ticket.ticket_type_id}`,
      section: ticket.seating_section ?? ticket.type_name,
      price: Number(ticket.price),
      status: toStatus(ticket.quantity_available, ticket.quantity_total),
    })),
  });
}

// -----------------------------------------------------------------------
// POST /events — organisers publish a new event with its venue and tickets
// -----------------------------------------------------------------------

app.post('/events', async (req, res) => {
  const body = req.body as EventFormBody;
  const validationError = validEventForm(body);
  if (!body.organizerEmail || validationError) {
    res.status(400).json({ error: validationError ?? 'organizer_required' });
    return;
  }

  try {
    const organizerId = await resolveCustomerByEmail(body.organizerEmail);
    const venueId = await resolveVenue(body.venue);
    const eventType = EVENT_TYPES.has(body.eventType ?? '') ? body.eventType : 'other';
    const tickets = body.tickets!;
    const totalCapacity = tickets.reduce((sum, ticket) => sum + (ticket.quantity ?? 0), 0);

    const [result] = await pool.query(
      `INSERT INTO events
         (event_name, event_description, event_type, venue_id, organizer_id,
          event_start_datetime, event_end_datetime, status, total_capacity, featured)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?)`,
      [
        body.name!.trim(),
        body.description ?? '',
        eventType,
        venueId,
        organizerId,
        new Date(body.startDateTime!),
        new Date(body.endDateTime!),
        totalCapacity,
        Boolean(body.featured),
      ],
    );
    const eventId = (result as { insertId: number }).insertId;
    for (const ticket of tickets) {
      await pool.query(
        `INSERT INTO ticket_types
           (event_id, type_name, seating_section, price, quantity_total, quantity_available,
            sale_start_datetime, sale_end_datetime, status)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, 'active')`,
        [eventId, ticket.name, ticket.section || null, ticket.price, ticket.quantity, ticket.quantity, new Date(body.startDateTime!)],
      );
    }

    await pool.query(
      `INSERT INTO customer_event_roles (customer_id, event_id, role_id)
       VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE role_id = VALUES(role_id)`,
      [organizerId, eventId],
    );
    await saveEventImage(eventId, body.image);

    await respondWithEvent(res, eventId, 201);
  } catch (error) {
    console.error('POST /events failed', error);
    res.status(500).json({ error: 'event_create_failed' });
  }
});

// -----------------------------------------------------------------------
// PUT /events/:id — organisers edit an event, its venue and its tickets
// -----------------------------------------------------------------------

app.put('/events/:id', async (req, res) => {
  const eventId = Number(req.params.id);
  if (!Number.isInteger(eventId)) {
    res.status(400).json({ error: 'invalid_event_id' });
    return;
  }

  const body = req.body as EventFormBody;
  const validationError = validEventForm(body);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  try {
    const [existingEvent] = await pool.query<RowDataPacket[]>('SELECT event_id FROM events WHERE event_id = ?', [
      eventId,
    ]);
    if (!existingEvent[0]) {
      res.status(404).json({ error: 'event_not_found' });
      return;
    }

    const venueId = await resolveVenue(body.venue);
    const eventType = EVENT_TYPES.has(body.eventType ?? '') ? body.eventType : 'other';
    const tickets = body.tickets!;
    const totalCapacity = tickets.reduce((sum, ticket) => sum + (ticket.quantity ?? 0), 0);

    await pool.query(
      `UPDATE events
       SET event_name = ?, event_description = ?, event_type = ?, venue_id = ?,
           event_start_datetime = ?, event_end_datetime = ?, total_capacity = ?, featured = ?
       WHERE event_id = ?`,
      [
        body.name!.trim(),
        body.description ?? '',
        eventType,
        venueId,
        new Date(body.startDateTime!),
        new Date(body.endDateTime!),
        totalCapacity,
        Boolean(body.featured),
        eventId,
      ],
    );
    await saveEventImage(eventId, body.image);

    const [existingTickets] = await pool.query<RowDataPacket[]>(
      'SELECT ticket_type_id, quantity_sold FROM ticket_types WHERE event_id = ?',
      [eventId],
    );
    const existingById = new Map(existingTickets.map((row) => [row.ticket_type_id as number, row]));
    const keptIds = new Set<number>();

    for (const ticket of tickets) {
      const numericId = ticket.id ? Number(String(ticket.id).replace(/\D/g, '')) : NaN;
      if (Number.isInteger(numericId) && existingById.has(numericId)) {
        keptIds.add(numericId);
        await pool.query(
          `UPDATE ticket_types
           SET type_name = ?, seating_section = ?, price = ?, quantity_total = ?,
               quantity_available = GREATEST(? - quantity_sold, 0), sale_end_datetime = ?, status = 'active'
           WHERE ticket_type_id = ?`,
          [ticket.name, ticket.section || null, ticket.price, ticket.quantity, ticket.quantity, new Date(body.startDateTime!), numericId],
        );
      } else {
        const [inserted] = await pool.query(
          `INSERT INTO ticket_types
             (event_id, type_name, seating_section, price, quantity_total, quantity_available,
              sale_start_datetime, sale_end_datetime, status)
           VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, 'active')`,
          [eventId, ticket.name, ticket.section || null, ticket.price, ticket.quantity, ticket.quantity, new Date(body.startDateTime!)],
        );
        keptIds.add((inserted as { insertId: number }).insertId);
      }
    }

    for (const row of existingTickets) {
      const ticketTypeId = row.ticket_type_id as number;
      if (keptIds.has(ticketTypeId)) {
        continue;
      }
      if ((row.quantity_sold as number) > 0) {
        await pool.query(`UPDATE ticket_types SET status = 'inactive' WHERE ticket_type_id = ?`, [ticketTypeId]);
      } else {
        await pool.query('DELETE FROM ticket_types WHERE ticket_type_id = ?', [ticketTypeId]);
      }
    }

    await respondWithEvent(res, eventId, 200);
  } catch (error) {
    console.error('PUT /events/:id failed', error);
    res.status(500).json({ error: 'event_update_failed' });
  }
});

// -----------------------------------------------------------------------
// Event team: who holds Admin or Helper on one event
// -----------------------------------------------------------------------

/** Role names the app writes to `customer_event_roles`; Customer is read-only here. */
const STAFF_ROLES: Record<string, number> = { organiser: 1, 'event-helper': 3 };
const ROLE_ID_TO_NAME: Record<number, 'organiser' | 'event-helper'> = { 1: 'organiser', 3: 'event-helper' };

interface StaffRow extends RowDataPacket {
  customer_id: number;
  first_name: string;
  last_name: string;
  email: string;
  role_id: number;
  added_at: Date;
}

app.get('/events/:id/staff', async (req, res) => {
  const eventId = Number(req.params.id);
  if (!Number.isInteger(eventId)) {
    res.status(400).json({ error: 'invalid_event_id' });
    return;
  }

  try {
    const [rows] = await pool.query<StaffRow[]>(
      `SELECT c.customer_id, c.first_name, c.last_name, c.email, cer.role_id, cer.added_at
       FROM customer_event_roles cer
       JOIN customers c ON c.customer_id = cer.customer_id
       WHERE cer.event_id = ? AND cer.role_id IN (1, 3)
       ORDER BY cer.added_at`,
      [eventId],
    );

    res.json(
      rows.map((row) => ({
        customerId: row.customer_id,
        name: `${row.first_name} ${row.last_name}`.trim(),
        email: row.email,
        role: ROLE_ID_TO_NAME[row.role_id],
        addedAt: row.added_at,
      })),
    );
  } catch (error) {
    console.error('GET /events/:id/staff failed', error);
    res.status(500).json({ error: 'staff_query_failed' });
  }
});

interface HelperShiftRow extends RowDataPacket {
  customer_id: number;
  event_id: number;
  event_name: string;
  venue_name: string;
  event_start_datetime: Date;
  doors_open_time: Date | null;
  total_capacity: number | null;
}

/** Upcoming events assigned to one helper through the event-role relationship. */
app.get('/helper/shifts', async (req, res) => {
  const email = typeof req.query.email === 'string' ? req.query.email.trim() : '';
  if (!email) {
    res.status(400).json({ error: 'email_required' });
    return;
  }
  try {
    const [rows] = await pool.query<HelperShiftRow[]>(
      `SELECT c.customer_id, e.event_id, e.event_name, v.venue_name,
              e.event_start_datetime, e.doors_open_time, e.total_capacity
       FROM customer_event_roles cer
       JOIN customers c ON c.customer_id = cer.customer_id
       JOIN events e ON e.event_id = cer.event_id
       JOIN venues v ON v.venue_id = e.venue_id
       WHERE c.email = ? AND cer.role_id = 3 AND e.status IN ('published', 'postponed')
       ORDER BY e.event_start_datetime`,
      [email],
    );
    res.json(rows.map((row) => ({
      staffId: row.customer_id,
      eventId: row.event_id,
      eventName: row.event_name,
      venueName: row.venue_name,
      gate: null,
      eventStartDatetime: row.event_start_datetime,
      doorsOpenTime: row.doors_open_time,
      expectedAttendance: row.total_capacity,
    })));
  } catch (error) {
    console.error('GET /helper/shifts failed', error);
    res.status(500).json({ error: 'helper_shifts_query_failed' });
  }
});

/**
 * Finds the customer for an email, creating a placeholder row the first time
 * anyone (an organiser adding a teammate, or that person's own first
 * request) mentions that address. `password_hash` is never read — Cognito
 * owns authentication — the column only exists because the schema predates
 * it and still marks it NOT NULL.
 */
async function resolveCustomerByEmail(email: string): Promise<number> {
  const [existing] = await pool.query<RowDataPacket[]>('SELECT customer_id FROM customers WHERE email = ?', [email]);
  if (existing[0]) {
    return existing[0].customer_id as number;
  }

  const namePart = email.split('@')[0] ?? 'member';
  const displayName = namePart
    .replace(/[._]/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

  const [result] = await pool.query(
    `INSERT INTO customers (customer_name, email, password_hash, first_name, last_name, status, email_verified)
     VALUES (?, ?, 'cognito-managed', ?, '', 'active', FALSE)`,
    [`${namePart}-${Date.now()}`, email, displayName],
  );

  return (result as { insertId: number }).insertId;
}

app.post('/events/:id/staff', async (req, res) => {
  const eventId = Number(req.params.id);
  const { email, role } = req.body as { email?: string; role?: string };

  if (!Number.isInteger(eventId)) {
    res.status(400).json({ error: 'invalid_event_id' });
    return;
  }
  if (!email || !role || !(role in STAFF_ROLES)) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }

  try {
    const customerId = await resolveCustomerByEmail(email);
    const roleId = STAFF_ROLES[role];

    await pool.query(
      `INSERT INTO customer_event_roles (customer_id, event_id, role_id)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE role_id = VALUES(role_id), added_at = CURRENT_TIMESTAMP`,
      [customerId, eventId, roleId],
    );

    res.status(201).json({ customerId, email, role, eventId });
  } catch (error) {
    console.error('POST /events/:id/staff failed', error);
    res.status(500).json({ error: 'staff_add_failed' });
  }
});

app.delete('/events/:id/staff/:customerId', async (req, res) => {
  const eventId = Number(req.params.id);
  const customerId = Number(req.params.customerId);
  if (!Number.isInteger(eventId) || !Number.isInteger(customerId)) {
    res.status(400).json({ error: 'invalid_id' });
    return;
  }

  try {
    await pool.query(
      'DELETE FROM customer_event_roles WHERE event_id = ? AND customer_id = ? AND role_id IN (1, 3)',
      [eventId, customerId],
    );
    res.status(204).send();
  } catch (error) {
    console.error('DELETE /events/:id/staff/:customerId failed', error);
    res.status(500).json({ error: 'staff_remove_failed' });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`${SERVICE}-service -> http://${HOST}:${PORT}`);
});
