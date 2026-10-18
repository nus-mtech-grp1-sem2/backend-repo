import express from 'express';
import mysql from 'mysql2/promise';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { setTimeout as delay } from 'node:timers/promises';
import { consumePayments, enqueuePayment, type PaymentResult } from './payment-queue.js';
import { withTransaction } from './transaction.js';

const SERVICE = 'order';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3004);
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? '';
const CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? '';
const ORDER_EVENTS_QUEUE_URL = process.env.ORDER_EVENTS_QUEUE_URL ?? '';
const PAYMENT_REQUESTS_QUEUE_URL = process.env.PAYMENT_REQUESTS_QUEUE_URL ?? '';
const TICKET_SERVICE_URL = process.env.TICKET_SERVICE_URL ?? '';
const TICKET_INTERNAL_SHARED_SECRET = process.env.TICKET_INTERNAL_SHARED_SECRET ?? '';
const QUEUE_SERVICE_URL = process.env.QUEUE_SERVICE_URL ?? '';
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN ?? '';
const QUEUE_REFILL_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.QUEUE_REFILL_TIMEOUT_MS) || 1_000, 100),
  5_000,
);
export const RESERVATION_TIMEOUT_MINUTES = 3;
/** Most tickets one order can buy. */
export const MAX_TICKETS_PER_ORDER = 50;
export const DATABASE_TIMEZONE = 'Z';
const RESERVATION_SWEEP_INTERVAL_MS = Math.min(
  Math.max(Number(process.env.RESERVATION_SWEEP_INTERVAL_MS) || 1_000, 250),
  60_000,
);
let verifier = USER_POOL_ID && CLIENT_ID
  ? CognitoJwtVerifier.create({ userPoolId: USER_POOL_ID, clientId: CLIENT_ID, tokenUse: 'access' })
  : null;

export function __setVerifierForTests(fake: typeof verifier): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('test verifier can only be set in test mode');
  verifier = fake;
}
const sqs = new SQSClient({ requestHandler: { connectionTimeout: 3_000, requestTimeout: 25_000 }, maxAttempts: 2 });
const databaseConfigured = Boolean(
  process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER && process.env.DB_PASSWORD,
);
const database = mysql.createPool({
  host: process.env.DB_HOST ?? '',
  port: Number(process.env.DB_PORT ?? 3306),
  database: process.env.DB_NAME ?? '',
  user: process.env.DB_USER ?? '',
  password: process.env.DB_PASSWORD ?? '',
  timezone: DATABASE_TIMEZONE,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT ?? 8),
  connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT ?? 10_000),
  ...(process.env.DB_SSL === 'false' ? {} : { ssl: { rejectUnauthorized: false } }),
});

class OrderRequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

interface Caller { readonly sub: string; readonly email: string }
interface CreateOrderInput {
  readonly holdId?: unknown;
  readonly eventId?: unknown;
  readonly inventoryItemId?: unknown;
  readonly quantity?: unknown;
  readonly seatIds?: unknown;
  readonly admissionToken?: unknown;
  readonly customerEmail?: unknown;
  readonly customerName?: unknown;
}
interface PaymentInput { readonly paymentToken?: unknown }
interface CancellationInput { readonly reason?: unknown }
interface OrderItem {
  readonly inventoryItemId: number;
  readonly seatId: number | null;
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
}
interface HoldData {
  readonly hold_id: number;
  readonly event_id: number;
  readonly inventory_item_id: number | null;
  readonly customer_sub?: string;
  readonly quantity: number;
  readonly status?: string;
  readonly expires_at?: Date;
  readonly order_id?: number | null;
}
interface LoadedOrder {
  readonly order_id: number;
  readonly event_id: number;
  readonly customer_sub: string;
  readonly customer_email: string;
  readonly customer_name: string;
  readonly hold_id: number;
  readonly status: string;
  readonly total_amount_cents: number;
  readonly currency: string;
  readonly created_at: Date;
  readonly paid_at: Date | null;
  readonly reservation_expires_at: Date;
  readonly items: mysql.RowDataPacket[];
  readonly payments: mysql.RowDataPacket[];
}
interface ReservationRow extends mysql.RowDataPacket {
  readonly order_id: number;
  readonly event_id: number;
  readonly customer_sub: string;
  readonly order_status: string;
  readonly hold_id: number;
  readonly inventory_item_id: number | null;
  readonly quantity: number;
  readonly hold_status: string;
  readonly expires_at: Date;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.get('/health', (_req, res) => res.json({ status: 'ok', service: SERVICE }));

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

// Display/door-lookup data supplied by the client; never use it for authorisation.
export function cleanCustomerName(value: string): string {
  return Array.from(value.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim()).slice(0, 255).join('').trim();
}

function parseCreateOrder(input: CreateOrderInput): {
  holdId: number | null;
  eventId: number | null;
  inventoryItemId: number | null;
  quantity: number | null;
  seatIds: number[];
  admissionToken: string | null;
  customerEmail: string;
  customerName: string;
} | null {
  const holdId = input.holdId === undefined ? null : positiveInteger(input.holdId);
  const eventId = input.eventId === undefined ? null : positiveInteger(input.eventId);
  const inventoryItemId = input.inventoryItemId === undefined ? null : positiveInteger(input.inventoryItemId);
  const quantity = input.quantity === undefined ? null : positiveInteger(input.quantity);
  const rawSeatIds = input.seatIds === undefined ? [] : input.seatIds;
  if (!Array.isArray(rawSeatIds)) return null;
  const seatIds = rawSeatIds.map(positiveInteger);
  const admissionToken = typeof input.admissionToken === 'string' && input.admissionToken.length <= 255
    ? input.admissionToken.trim() || null : null;
  const customerEmail = typeof input.customerEmail === 'string' ? input.customerEmail.trim().toLowerCase() : '';
  if (seatIds.some((id) => id === null) || new Set(seatIds).size !== seatIds.length || seatIds.length > MAX_TICKETS_PER_ORDER) return null;
  if (input.customerName !== undefined && input.customerName !== null && typeof input.customerName !== 'string') return null;
  const customerName = typeof input.customerName === 'string' ? cleanCustomerName(input.customerName) : '';
  if (customerEmail && (customerEmail.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail))) return null;
  if (holdId && !eventId && !quantity && seatIds.length === 0) {
    return { holdId, eventId: null, inventoryItemId, quantity: null, seatIds: [], admissionToken, customerEmail, customerName };
  }
  if (!eventId || !quantity || quantity > MAX_TICKETS_PER_ORDER || (seatIds.length > 0 && seatIds.length !== quantity)) return null;
  return { holdId: null, eventId, inventoryItemId, quantity, seatIds: seatIds as number[], admissionToken, customerEmail, customerName };
}

async function authenticate(req: express.Request): Promise<Caller | null> {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !verifier) return null;
  try {
    const claims = await verifier.verify(token);
    return { sub: String(claims.sub), email: typeof claims.email === 'string' ? claims.email.toLowerCase() : '' };
  } catch { return null; }
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

/**
 * Why tickets for an event cannot be bought right now, or null when they can.
 * Events carry a start time but no end time, so one that has started is
 * completed and never on sale, whatever its status. `has_started` is computed
 * by MySQL against UTC_TIMESTAMP(), the same reading of the stored start time
 * that the event API and the web app use.
 */
export function saleBlockReason(
  event: Readonly<Record<string, unknown>>,
): 'event_not_on_sale' | 'event_completed' | null {
  if (event['status'] !== 'PUBLISHED') return 'event_not_on_sale';
  return Number(event['has_started']) === 1 ? 'event_completed' : null;
}

export interface ZoneCandidate {
  readonly inventoryItemId: number;
  readonly priceCents: number;
  readonly totalQty: number;
  readonly reservedQty: number;
  readonly soldQty: number;
}

/**
 * A GA event can have several zones/tiers (e.g. 20 cheap seats, 8 pricier
 * ones). Without a requested zone, pick the cheapest one that still has
 * enough capacity — airline-style fare-class fallback — rather than always
 * the first-created zone, which previously 409'd once it sold out even
 * though a pricier zone still had room.
 */
export function selectAvailableZone(
  zones: readonly ZoneCandidate[],
  quantity: number,
  requestedInventoryItemId: number | null,
): ZoneCandidate | null {
  const hasCapacity = (zone: ZoneCandidate): boolean =>
    zone.totalQty - zone.reservedQty - zone.soldQty >= quantity;

  if (requestedInventoryItemId !== null) {
    const zone = zones.find((z) => z.inventoryItemId === requestedInventoryItemId);
    return zone && hasCapacity(zone) ? zone : null;
  }

  const cheapestFirst = [...zones].sort((a, b) =>
    a.priceCents - b.priceCents || a.inventoryItemId - b.inventoryItemId);
  return cheapestFirst.find(hasCapacity) ?? null;
}

async function loadOrder(orderId: number): Promise<LoadedOrder | null> {
  const [orders] = await database.query<mysql.RowDataPacket[]>(
    `SELECT o.order_id, o.event_id, o.customer_sub, o.customer_email, o.customer_name, o.hold_id, o.status,
       o.total_amount_cents, o.currency, o.created_at, o.paid_at,
       h.expires_at AS reservation_expires_at
     FROM orders o
     INNER JOIN event_inventory.inventory_holds h ON h.hold_id = o.hold_id
     WHERE o.order_id = ? LIMIT 1`, [orderId],
  );
  if (!orders[0]) return null;
  const [items] = await database.query<mysql.RowDataPacket[]>(
    `SELECT order_item_id, inventory_item_id, seat_id, description, quantity, unit_price_cents
     FROM order_items WHERE order_id = ? ORDER BY order_item_id`, [orderId],
  );
  const [payments] = await database.query<mysql.RowDataPacket[]>(
    'SELECT payment_id, status, amount_cents, processed_at FROM payments WHERE order_id = ? ORDER BY payment_id', [orderId],
  );
  return { ...orders[0], items, payments } as LoadedOrder;
}

/** Discover identifiers with consistent reads, never locking the session or
 * scanning its secondary index inside a queue-entry UPDATE. */
async function findQueueEntryId(
  connection: mysql.PoolConnection,
  eventId: number,
  customerSub: string,
): Promise<number | null> {
  const [sessions] = await connection.query<mysql.RowDataPacket[]>(
    'SELECT queue_session_id FROM `queue`.queue_sessions WHERE event_id = ? LIMIT 1', [eventId],
  );
  if (!sessions[0]) return null;
  const [entries] = await connection.query<mysql.RowDataPacket[]>(
    'SELECT queue_entry_id FROM `queue`.queue_entries WHERE queue_session_id = ? AND customer_sub = ? LIMIT 1',
    [sessions[0].queue_session_id, customerSub],
  );
  return entries[0] ? Number(entries[0].queue_entry_id) : null;
}

async function releaseQueueEntry(
  connection: mysql.PoolConnection,
  eventId: number,
  customerSub: string,
  holdId: number,
): Promise<boolean> {
  const queueEntryId = await findQueueEntryId(connection, eventId, customerSub);
  if (queueEntryId === null) return false;
  const [holds] = await connection.query<mysql.RowDataPacket[]>(
    'SELECT expires_at FROM event_inventory.inventory_holds WHERE hold_id = ? LIMIT 1', [holdId],
  );
  if (!holds[0]) return false;
  const [released] = await connection.execute<mysql.ResultSetHeader>(
    `UPDATE \`queue\`.queue_entries
     SET status = 'LEFT', admission_token = NULL, token_expires_at = NULL
     WHERE queue_entry_id = ? AND status = 'IN_CHECKOUT' AND token_expires_at = ?`,
    [queueEntryId, holds[0].expires_at],
  );
  // The expiry guard prevents a replay/cancellation releasing a newer checkout.
  return released.affectedRows > 0;
}

async function releaseReservation(
  connection: mysql.PoolConnection,
  reservation: ReservationRow,
  holdStatus: 'EXPIRED' | 'RELEASED',
): Promise<boolean> {
  if (reservation.inventory_item_id) {
    const [inventoryRelease] = await connection.execute<mysql.ResultSetHeader>(
      `UPDATE event_inventory.inventory_items
       SET reserved_qty = reserved_qty - ?, version = version + 1
       WHERE inventory_item_id = ? AND reserved_qty >= ?`,
      [reservation.quantity, reservation.inventory_item_id, reservation.quantity],
    );
    if (inventoryRelease.affectedRows !== 1) throw new Error('reserved_inventory_mismatch');
  } else {
    await connection.execute(
      "UPDATE event_inventory.seats SET status = 'AVAILABLE', hold_id = NULL WHERE hold_id = ? AND status = 'HELD'",
      [reservation.hold_id],
    );
  }
  const [holdRelease] = await connection.execute<mysql.ResultSetHeader>(
    "UPDATE event_inventory.inventory_holds SET status = ? WHERE hold_id = ? AND status = 'ACTIVE'",
    [holdStatus, reservation.hold_id],
  );
  if (holdRelease.affectedRows !== 1) throw new Error('reservation_already_released');
  await connection.execute(
    "UPDATE orders SET status = 'CANCELLED' WHERE order_id = ? AND status = 'PENDING'",
    [reservation.order_id],
  );
  return releaseQueueEntry(connection, reservation.event_id, reservation.customer_sub, reservation.hold_id);
}

async function expireReservations(filters: {
  readonly eventId?: number;
  readonly orderId?: number;
  readonly customerSub?: string;
} = {}): Promise<number> {
  const clauses = ["o.status = 'PENDING'", "h.status = 'ACTIVE'", 'h.expires_at <= CURRENT_TIMESTAMP'];
  const params: unknown[] = [];
  if (filters.eventId) { clauses.push('o.event_id = ?'); params.push(filters.eventId); }
  if (filters.orderId) { clauses.push('o.order_id = ?'); params.push(filters.orderId); }
  if (filters.customerSub) { clauses.push('o.customer_sub = ?'); params.push(filters.customerSub); }
  // Discover candidates without locking the event/status secondary index.
  // Payment locks orders by primary key; expiry must use the same order.
  const [candidates] = await database.query<ReservationRow[]>(
    `SELECT o.order_id, o.event_id, o.customer_sub, o.status AS order_status,
       h.hold_id, h.inventory_item_id, h.quantity, h.status AS hold_status, h.expires_at
     FROM orders o
     INNER JOIN event_inventory.inventory_holds h ON h.hold_id = o.hold_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY o.order_id`, params,
  );
  let expired = 0;
  const queueEvents = new Set<number>();
  for (const candidate of candidates) {
    const result = await withTransaction(database, async (connection) => {
      const [orders] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT order_id, event_id, customer_sub, hold_id, status FROM orders WHERE order_id = ? LIMIT 1 FOR UPDATE',
        [candidate.order_id],
      );
      const order = orders[0];
      if (!order || order.status !== 'PENDING') return null;
      const [holds] = await connection.query<mysql.RowDataPacket[]>(
        `SELECT hold_id, inventory_item_id, quantity, status, expires_at
         FROM event_inventory.inventory_holds WHERE hold_id = ?
           AND status = 'ACTIVE' AND expires_at <= CURRENT_TIMESTAMP FOR UPDATE`,
        [order.hold_id],
      );
      const hold = holds[0];
      // A payment or another sweeper may have settled the candidate already.
      if (!hold) return null;
      const reservation = { ...order, ...hold, order_status: order.status, hold_status: hold.status } as ReservationRow;
      const released = await releaseReservation(connection, reservation, 'EXPIRED');
      return { eventId: Number(order.event_id), released };
    });
    if (result) {
      expired += 1;
      if (result.released) queueEvents.add(result.eventId);
    }
  }
  for (const eventId of queueEvents) await refillReleasedQueueSlot(eventId);
  return expired;
}

async function itemsForHold(connection: mysql.PoolConnection, hold: HoldData): Promise<OrderItem[]> {
  if (hold.inventory_item_id) {
    const [inventory] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT inventory_item_id, name, price_cents FROM event_inventory.inventory_items WHERE inventory_item_id = ? LIMIT 1',
      [hold.inventory_item_id],
    );
    const item = inventory[0];
    if (!item) throw new Error('hold_inventory_missing');
    return [{ inventoryItemId: Number(item.inventory_item_id), seatId: null, description: String(item.name), quantity: Number(hold.quantity), unitPriceCents: Number(item.price_cents) }];
  }
  const [seats] = await connection.query<mysql.RowDataPacket[]>(
    `SELECT s.seat_id, s.inventory_item_id, s.seat_label, i.name, i.price_cents
     FROM event_inventory.seats s INNER JOIN event_inventory.inventory_items i ON i.inventory_item_id = s.inventory_item_id
     WHERE s.hold_id = ? ORDER BY s.seat_id`, [hold.hold_id],
  );
  return seats.map((seat) => ({
    inventoryItemId: Number(seat.inventory_item_id), seatId: Number(seat.seat_id),
    description: `${seat.name} - ${seat.seat_label}`, quantity: 1, unitPriceCents: Number(seat.price_cents),
  }));
}

app.post('/orders', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!requireDatabase(res)) return;
  const body = (req.body ?? {}) as CreateOrderInput;
  // Say why, so the buyer can split a big purchase instead of guessing.
  const requested = positiveInteger(body.quantity);
  if ((requested !== null && requested > MAX_TICKETS_PER_ORDER) ||
      (Array.isArray(body.seatIds) && body.seatIds.length > MAX_TICKETS_PER_ORDER)) {
    return res.status(400).json({ error: 'too_many_tickets', maxQuantity: MAX_TICKETS_PER_ORDER });
  }
  const input = parseCreateOrder(body);
  if (!input) return res.status(400).json({ error: 'invalid_order' });
  const customerEmail = caller.email || input.customerEmail;
  if (!customerEmail) return res.status(400).json({ error: 'customer_email_required' });
  try {
    if (input.eventId) await expireReservations({ eventId: input.eventId });
    const result = await withTransaction(database, async (connection) => {
      let holdId = input.holdId;
      let eventId = input.eventId;
      let hold: HoldData | undefined;
      let queueEntryId: number | null = null;
      if (holdId) {
        const [holds] = await connection.query<mysql.RowDataPacket[]>(
          `SELECT hold_id, event_id, inventory_item_id, customer_sub, quantity, status, expires_at, order_id
           FROM event_inventory.inventory_holds WHERE hold_id = ? LIMIT 1 FOR UPDATE`, [holdId],
        );
        hold = holds[0] as HoldData | undefined;
        if (!hold) throw new OrderRequestError(404, 'hold_not_found');
        if (hold.customer_sub !== caller.sub) throw new OrderRequestError(403, 'hold_owner_required');
        if (hold.order_id) {
          return { status: 200, orderId: Number(hold.order_id) };
        }
        if (hold.status !== 'ACTIVE' || !hold.expires_at || new Date(hold.expires_at).getTime() <= Date.now()) {
          throw new OrderRequestError(409, 'hold_not_active');
        }
        await connection.execute(
          `UPDATE event_inventory.inventory_holds
           SET expires_at = LEAST(expires_at, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ${RESERVATION_TIMEOUT_MINUTES} MINUTE))
           WHERE hold_id = ?`, [holdId],
        );
        eventId = Number(hold.event_id);
      }
      const [events] = await connection.query<mysql.RowDataPacket[]>(
        `SELECT event_id, tier, status, starts_at < UTC_TIMESTAMP() AS has_started
         FROM event_inventory.events WHERE event_id = ? LIMIT 1`, [eventId],
      );
      const event = events[0];
      if (!event || eventId === null) throw new OrderRequestError(404, 'event_not_found');
      const saleBlock = saleBlockReason(event);
      if (saleBlock) throw new OrderRequestError(409, saleBlock);

      // Both tiers sell through the queue: a direct order needs a live admission token.
      if (!input.holdId) {
        if (!input.admissionToken) throw new OrderRequestError(403, 'queue_admission_required');
        queueEntryId = await findQueueEntryId(connection, eventId, caller.sub);
        if (queueEntryId === null) throw new OrderRequestError(403, 'queue_admission_required');
        // Recheck under a primary-key lock on this buyer only. Locking the join
        // also locks the shared session, inverting payment's inventory -> queue order.
        const [admissions] = await connection.query<mysql.RowDataPacket[]>(
          `SELECT e.queue_entry_id FROM \`queue\`.queue_entries e
           WHERE e.queue_entry_id = ? AND e.customer_sub = ? AND e.status = 'ADMITTED'
             AND e.admission_token = ? AND e.token_expires_at > CURRENT_TIMESTAMP FOR UPDATE`,
          [queueEntryId, caller.sub, input.admissionToken],
        );
        if (!admissions[0]) throw new OrderRequestError(403, 'queue_admission_required');
      }

      if (!hold) {
        if (event.tier === 'TIER2_SEATED') {
          if (input.seatIds.length !== input.quantity) throw new OrderRequestError(400, 'seat_selection_required');
          const placeholders = input.seatIds.map(() => '?').join(', ');
          const [seats] = await connection.query<mysql.RowDataPacket[]>(
            `SELECT s.seat_id, s.inventory_item_id, s.seat_label, s.status, i.name, i.price_cents
             FROM event_inventory.seats s INNER JOIN event_inventory.inventory_items i ON i.inventory_item_id = s.inventory_item_id
             WHERE s.event_id = ? AND s.seat_id IN (${placeholders}) ORDER BY s.seat_id FOR UPDATE`, [eventId, ...input.seatIds],
          );
          if (seats.length !== input.quantity || seats.some((seat) => seat.status !== 'AVAILABLE')) {
            throw new OrderRequestError(409, 'inventory_unavailable');
          }
          const [insert] = await connection.execute<mysql.ResultSetHeader>(
            `INSERT INTO event_inventory.inventory_holds (event_id, customer_sub, quantity, expires_at)
             VALUES (?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ${RESERVATION_TIMEOUT_MINUTES} MINUTE))`, [eventId, caller.sub, input.quantity],
          );
          holdId = insert.insertId;
          await connection.execute(
            `UPDATE event_inventory.seats SET status = 'HELD', hold_id = ? WHERE seat_id IN (${placeholders})`, [holdId, ...input.seatIds],
          );
          hold = { hold_id: insert.insertId, event_id: eventId!, inventory_item_id: null, quantity: input.quantity! };
        } else {
          // Lock a requested zone by primary key. Otherwise lock event zones
          // in a stable order and select the cheapest one with capacity.
          const [inventory] = input.inventoryItemId
            ? await connection.query<mysql.RowDataPacket[]>(
                `SELECT inventory_item_id, price_cents, total_qty, reserved_qty, sold_qty
                 FROM event_inventory.inventory_items
                 WHERE inventory_item_id = ? AND event_id = ? FOR UPDATE`,
                [input.inventoryItemId, eventId],
              )
            : await connection.query<mysql.RowDataPacket[]>(
                `SELECT inventory_item_id, price_cents, total_qty, reserved_qty, sold_qty
                 FROM event_inventory.inventory_items
                 WHERE event_id = ? ORDER BY inventory_item_id FOR UPDATE`,
                [eventId],
              );
          const item = selectAvailableZone(
            inventory.map((row) => ({
              inventoryItemId: Number(row.inventory_item_id),
              priceCents: Number(row.price_cents),
              totalQty: Number(row.total_qty),
              reservedQty: Number(row.reserved_qty),
              soldQty: Number(row.sold_qty),
            })),
            input.quantity!,
            input.inventoryItemId,
          );
          if (!item) {
            throw new OrderRequestError(409, 'inventory_unavailable');
          }
          await connection.execute(
            'UPDATE event_inventory.inventory_items SET reserved_qty = reserved_qty + ?, version = version + 1 WHERE inventory_item_id = ?',
            [input.quantity, item.inventoryItemId],
          );
          const [insert] = await connection.execute<mysql.ResultSetHeader>(
            `INSERT INTO event_inventory.inventory_holds (event_id, inventory_item_id, customer_sub, quantity, expires_at)
             VALUES (?, ?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ${RESERVATION_TIMEOUT_MINUTES} MINUTE))`,
            [eventId, item.inventoryItemId, caller.sub, input.quantity],
          );
          holdId = insert.insertId;
          hold = { hold_id: insert.insertId, event_id: eventId!, inventory_item_id: item.inventoryItemId, quantity: input.quantity! };
        }
      }

      const items = await itemsForHold(connection, hold!);
      if (items.length === 0) throw new OrderRequestError(409, 'hold_has_no_inventory');
      const totalAmountCents = items.reduce((total, item) => total + item.quantity * item.unitPriceCents, 0);
      const [insert] = await connection.execute<mysql.ResultSetHeader>(
        `INSERT INTO orders (event_id, customer_sub, customer_email, customer_name, hold_id, total_amount_cents)
         VALUES (?, ?, ?, ?, ?, ?)`, [eventId, caller.sub, customerEmail, input.customerName, holdId, totalAmountCents],
      );
      for (const item of items) {
        await connection.execute(
          `INSERT INTO order_items (order_id, inventory_item_id, seat_id, description, quantity, unit_price_cents)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [insert.insertId, item.inventoryItemId, item.seatId, item.description, item.quantity, item.unitPriceCents],
        );
      }
      await connection.execute('UPDATE event_inventory.inventory_holds SET order_id = ? WHERE hold_id = ?', [insert.insertId, holdId]);
      if (input.admissionToken) {
        queueEntryId ??= await findQueueEntryId(connection, eventId, caller.sub);
        const [holdExpiry] = await connection.query<mysql.RowDataPacket[]>(
          'SELECT expires_at FROM event_inventory.inventory_holds WHERE hold_id = ? LIMIT 1', [holdId],
        );
        if (!holdExpiry[0]?.expires_at) throw new Error('hold_expiry_missing');
        await connection.execute(
          `UPDATE \`queue\`.queue_entries SET status = 'IN_CHECKOUT', token_expires_at = ?
           WHERE queue_entry_id = ? AND customer_sub = ? AND admission_token = ?`,
          [holdExpiry[0].expires_at, queueEntryId, caller.sub, input.admissionToken],
        );
      }
      return { status: 201, orderId: insert.insertId };
    });
    return res.status(result.status).json({ order: await loadOrder(result.orderId) });
  } catch (error) {
    if (error instanceof OrderRequestError) return res.status(error.status).json({ error: error.code });
    console.error('order creation failed', error);
    return res.status(502).json({ error: 'order_create_failed' });
  }
});

async function publishOrderPaid(order: NonNullable<Awaited<ReturnType<typeof loadOrder>>>): Promise<void> {
  if (!ORDER_EVENTS_QUEUE_URL) {
    await requestTicketIssuance(Number(order.order_id));
    return;
  }
  await sqs.send(new SendMessageCommand({
    QueueUrl: ORDER_EVENTS_QUEUE_URL,
    DelaySeconds: 10,
    MessageBody: JSON.stringify({
      type: 'OrderPaid', version: 1, occurredAt: new Date().toISOString(),
      orderId: Number(order.order_id), eventId: Number(order.event_id), customerSub: order.customer_sub,
      customerEmail: order.customer_email, customerName: order.customer_name ?? '', paidAt: order.paid_at, items: order.items,
    }),
  }));
}

export async function requestTicketIssuance(
  orderId: number,
  ticketServiceUrl = TICKET_SERVICE_URL,
  sharedSecret = TICKET_INTERNAL_SHARED_SECRET,
  requester: typeof fetch = fetch,
): Promise<boolean> {
  if (!ticketServiceUrl || !sharedSecret) return false;
  const response = await requester(
    `${ticketServiceUrl.replace(/\/$/, '')}/internal/orders/${orderId}/issue-tickets`,
    {
      method: 'POST',
      headers: { 'x-ticket-internal-secret': sharedSecret },
    },
  );
  if (!response.ok) throw new Error(`ticket_issuance_failed:${response.status}`);
  return true;
}

export async function requestQueueRefill(
  eventId: number,
  queueServiceUrl = QUEUE_SERVICE_URL,
  internalApiToken = INTERNAL_API_TOKEN,
  requester: typeof fetch = fetch,
  timeoutMs = QUEUE_REFILL_TIMEOUT_MS,
): Promise<boolean> {
  if (!queueServiceUrl || !internalApiToken) return false;
  const response = await requester(
    `${queueServiceUrl.replace(/\/$/, '')}/events/${eventId}/queue/admit-next`,
    {
      method: 'POST',
      headers: { 'x-internal-token': internalApiToken },
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!response.ok) throw new Error(`queue_refill_failed:${response.status}`);
  return true;
}

async function refillReleasedQueueSlot(eventId: number): Promise<void> {
  try {
    await requestQueueRefill(eventId);
  } catch (error) {
    // The queue scheduler is the fallback, so payment remains successful if
    // this low-latency notification is unavailable.
    console.error('immediate queue refill failed', { eventId, error });
  }
}

app.post('/orders/:orderId/payment', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!requireDatabase(res)) return;
  const orderId = positiveInteger(req.params.orderId);
  const paymentToken = ((req.body ?? {}) as PaymentInput).paymentToken;
  const token = typeof paymentToken === 'string' ? paymentToken.trim() : '';
  if (!orderId || !token || token.length > 255) return res.status(400).json({ error: 'invalid_payment' });
  const result = await processPayment(orderId, caller.sub, token);
  return res.status(result.status).json(result.body);
});

// Additive endpoint: legacy /payment clients retain their synchronous contract.
// Only the fixed mock token is accepted; card details never enter a queue or database.
app.post('/orders/:orderId/payment-requests', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!requireDatabase(res)) return;
  const orderId = positiveInteger(req.params.orderId);
  if (!orderId || ((req.body ?? {}) as PaymentInput).paymentToken !== 'simulated') {
    return res.status(400).json({ error: 'invalid_payment' });
  }
  const order = await loadOrder(orderId);
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  if (order.customer_sub !== caller.sub) return res.status(403).json({ error: 'order_owner_required' });
  if (!['PENDING', 'PAID'].includes(order.status)) return res.status(409).json({ error: 'order_not_payable' });
  if (!PAYMENT_REQUESTS_QUEUE_URL) {
    // Explicit local-development fallback, never used when a queue is configured but unavailable.
    await delay(7_000);
    const result = await processPayment(orderId, caller.sub, 'simulated');
    return res.status(result.status).json(result.body);
  }
  try {
    await enqueuePayment(sqs, PAYMENT_REQUESTS_QUEUE_URL, { orderId, customerSub: caller.sub });
    return res.status(202).json({ order, paymentStatus: 'PROCESSING' });
  } catch {
    // A lost acknowledgement can mean SQS accepted it. The client checks status before retrying.
    console.error('payment enqueue failed', { orderId });
    return res.status(503).json({ error: 'payment_queue_unavailable' });
  }
});

export async function processPayment(orderId: number, customerSub: string, token: string): Promise<PaymentResult> {
  try {
    const result = await withTransaction(database, async (connection): Promise<PaymentResult & { refillEventId?: number | null }> => {
      const [orders] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT order_id, event_id, customer_sub, hold_id, total_amount_cents, status FROM orders WHERE order_id = ? LIMIT 1 FOR UPDATE', [orderId],
      );
      const order = orders[0];
      if (!order) throw new OrderRequestError(404, 'order_not_found');
      if (order.customer_sub !== customerSub) throw new OrderRequestError(403, 'order_owner_required');
      if (order.status === 'PAID') {
        const released = await releaseQueueEntry(connection, Number(order.event_id), order.customer_sub, Number(order.hold_id));
        return { status: 200, body: null, refillEventId: released ? Number(order.event_id) : null };
      }
      if (order.status !== 'PENDING') throw new OrderRequestError(409, 'order_not_payable');
      if (/^(fail|declin)/i.test(token)) {
        await connection.execute("INSERT INTO payments (order_id, payment_token, status, amount_cents) VALUES (?, ?, 'FAILED', ?)", [orderId, token, order.total_amount_cents]);
        await connection.execute("UPDATE orders SET status = 'FAILED' WHERE order_id = ?", [orderId]);
        const [failedHolds] = await connection.query<mysql.RowDataPacket[]>(
          'SELECT event_id, inventory_item_id, customer_sub, quantity FROM event_inventory.inventory_holds WHERE hold_id = ? LIMIT 1 FOR UPDATE', [order.hold_id],
        );
        const failedHold = failedHolds[0];
        if (failedHold?.inventory_item_id) {
          const [inventoryRelease] = await connection.execute<mysql.ResultSetHeader>(
            'UPDATE event_inventory.inventory_items SET reserved_qty = reserved_qty - ?, version = version + 1 WHERE inventory_item_id = ? AND reserved_qty >= ?',
            [failedHold.quantity, failedHold.inventory_item_id, failedHold.quantity],
          );
          if (inventoryRelease.affectedRows !== 1) throw new Error('reserved_inventory_mismatch');
        } else {
          await connection.execute("UPDATE event_inventory.seats SET status = 'AVAILABLE', hold_id = NULL WHERE hold_id = ? AND status = 'HELD'", [order.hold_id]);
        }
        await connection.execute("UPDATE event_inventory.inventory_holds SET status = 'RELEASED' WHERE hold_id = ?", [order.hold_id]);
        let releasedQueueSlot = false;
        if (failedHold) {
          releasedQueueSlot = await releaseQueueEntry(connection, Number(order.event_id), order.customer_sub, Number(order.hold_id));
        }
        return { status: 402, body: { error: 'payment_failed' }, refillEventId: releasedQueueSlot && failedHold ? Number(failedHold.event_id) : null };
      }
      const [holds] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT hold_id, inventory_item_id, quantity, status, expires_at FROM event_inventory.inventory_holds WHERE hold_id = ? LIMIT 1 FOR UPDATE', [order.hold_id],
      );
      const hold = holds[0];
      if (!hold || hold.status !== 'ACTIVE' || new Date(hold.expires_at).getTime() <= Date.now()) {
        // Release only an active hold, under the same row lock, so retries cannot release twice.
        if (hold?.status === 'ACTIVE') {
          if (hold.inventory_item_id) {
            const [released] = await connection.execute<mysql.ResultSetHeader>(
              'UPDATE event_inventory.inventory_items SET reserved_qty = reserved_qty - ?, version = version + 1 WHERE inventory_item_id = ? AND reserved_qty >= ?',
              [hold.quantity, hold.inventory_item_id, hold.quantity],
            );
            if (released.affectedRows !== 1) throw new Error('reserved_inventory_mismatch');
          } else {
            await connection.execute("UPDATE event_inventory.seats SET status = 'AVAILABLE', hold_id = NULL WHERE hold_id = ? AND status = 'HELD'", [order.hold_id]);
          }
          await connection.execute("UPDATE event_inventory.inventory_holds SET status = 'RELEASED' WHERE hold_id = ?", [order.hold_id]);
        }
        const releasedQueue = await releaseQueueEntry(connection, Number(order.event_id), order.customer_sub, Number(order.hold_id));
        await connection.execute("UPDATE orders SET status = 'FAILED' WHERE order_id = ? AND status = 'PENDING'", [orderId]);
        return { status: 409, body: { error: 'hold_not_active' }, refillEventId: releasedQueue ? Number(order.event_id) : null };
      }
      if (hold.inventory_item_id) {
        const [inventoryUpdate] = await connection.execute<mysql.ResultSetHeader>(
          `UPDATE event_inventory.inventory_items SET reserved_qty = reserved_qty - ?, sold_qty = sold_qty + ?, version = version + 1
           WHERE inventory_item_id = ? AND reserved_qty >= ?`, [hold.quantity, hold.quantity, hold.inventory_item_id, hold.quantity],
        );
        if (inventoryUpdate.affectedRows !== 1) throw new Error('reserved_inventory_mismatch');
      } else {
        const [seatUpdate] = await connection.execute<mysql.ResultSetHeader>(
          "UPDATE event_inventory.seats SET status = 'SOLD' WHERE hold_id = ? AND status = 'HELD'", [hold.hold_id],
        );
        if (seatUpdate.affectedRows !== Number(hold.quantity)) throw new Error('held_seat_count_mismatch');
      }
      await connection.execute("UPDATE event_inventory.inventory_holds SET status = 'CONFIRMED' WHERE hold_id = ?", [hold.hold_id]);
      await connection.execute("INSERT INTO payments (order_id, payment_token, status, amount_cents) VALUES (?, ?, 'CAPTURED', ?)", [orderId, token, order.total_amount_cents]);
      await connection.execute("UPDATE orders SET status = 'PAID', paid_at = CURRENT_TIMESTAMP WHERE order_id = ?", [orderId]);
      const released = await releaseQueueEntry(connection, Number(order.event_id), order.customer_sub, Number(order.hold_id));
      return { status: 200, body: null, refillEventId: released ? Number(order.event_id) : null };
    });
    if (result.refillEventId != null) await refillReleasedQueueSlot(result.refillEventId);
    if (result.status === 200) {
      const paid = await loadOrder(orderId);
      await publishOrderPaid(paid!);
      return { status: 200, body: { order: paid } };
    }
    return { status: result.status, body: result.body };
  } catch (error) {
    if (error instanceof OrderRequestError) return { status: error.status, body: { error: error.code } };
    console.error('payment processing failed', error);
    return { status: 502, body: { error: 'payment_processing_failed' } };
  }
}

app.get('/orders/:orderId', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!requireDatabase(res)) return;
  const orderId = positiveInteger(req.params.orderId);
  if (!orderId) return res.status(400).json({ error: 'invalid_order' });
  await expireReservations({ orderId });
  const order = await loadOrder(orderId);
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  if (order.customer_sub !== caller.sub && !(await hasEventRole(Number(order.event_id), caller.sub, ['ORGANISER']))) {
    return res.status(403).json({ error: 'order_access_denied' });
  }
  return res.json({ order });
});

app.post('/orders/:orderId/cancel', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!requireDatabase(res)) return;
  const orderId = positiveInteger(req.params.orderId);
  if (!orderId) return res.status(400).json({ error: 'invalid_order' });
  const input = (req.body ?? {}) as CancellationInput;
  if (input.reason !== undefined && input.reason !== 'expired') {
    return res.status(400).json({ error: 'invalid_cancellation_reason' });
  }

  try {
    const refillEventId = await withTransaction(database, async (connection) => {
      const [rows] = await connection.query<ReservationRow[]>(
        `SELECT o.order_id, o.event_id, o.customer_sub, o.status AS order_status,
           h.hold_id, h.inventory_item_id, h.quantity, h.status AS hold_status, h.expires_at
         FROM orders o
         INNER JOIN event_inventory.inventory_holds h ON h.hold_id = o.hold_id
         WHERE o.order_id = ? LIMIT 1 FOR UPDATE`, [orderId],
      );
      const reservation = rows[0];
      if (!reservation) throw new OrderRequestError(404, 'order_not_found');
      if (reservation.customer_sub !== caller.sub) throw new OrderRequestError(403, 'order_owner_required');
      if (reservation.order_status === 'CANCELLED') return null;
      if (reservation.order_status !== 'PENDING' || reservation.hold_status !== 'ACTIVE') {
        throw new OrderRequestError(409, 'reservation_not_cancellable');
      }
      const expired = new Date(reservation.expires_at).getTime() <= Date.now();
      if (input.reason === 'expired' && !expired) {
        throw new OrderRequestError(409, 'reservation_not_expired');
      }
      if (await releaseReservation(connection, reservation, expired ? 'EXPIRED' : 'RELEASED')) {
        return Number(reservation.event_id);
      }
      return null;
    });
    if (refillEventId !== null) await refillReleasedQueueSlot(refillEventId);
    return res.status(204).end();
  } catch (error) {
    if (error instanceof OrderRequestError) return res.status(error.status).json({ error: error.code });
    console.error('reservation cancellation failed', { orderId, error });
    return res.status(502).json({ error: 'reservation_cancel_failed' });
  }
});

app.get('/customers/me/orders', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!requireDatabase(res)) return;
  await expireReservations({ customerSub: caller.sub });
  // A cancelled event's orders are refunded and its tickets void, so the customer no longer sees them.
  const [orders] = await database.query<mysql.RowDataPacket[]>(
    `SELECT o.order_id, o.event_id, o.customer_email, o.hold_id, o.status,
      o.total_amount_cents, o.currency, o.created_at, o.paid_at,
      h.expires_at AS reservation_expires_at,
      e.title AS event_title, e.venue, e.starts_at,
      COALESCE(SUM(i.quantity), 0) AS ticket_count
     FROM orders o
     INNER JOIN event_inventory.events e ON e.event_id = o.event_id
     INNER JOIN event_inventory.inventory_holds h ON h.hold_id = o.hold_id
     LEFT JOIN order_items i ON i.order_id = o.order_id
     WHERE o.customer_sub = ? AND e.status <> 'CANCELLED'
     GROUP BY o.order_id, o.event_id, o.customer_email, o.hold_id, o.status,
       o.total_amount_cents, o.currency, o.created_at, o.paid_at, h.expires_at,
       e.title, e.venue, e.starts_at
     ORDER BY o.created_at DESC`, [caller.sub],
  );
  return res.json({ orders });
});

app.get('/events/:eventId/orders/summary', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!requireDatabase(res)) return;
  const eventId = positiveInteger(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  if (!(await hasEventRole(eventId, caller.sub, ['ORGANISER', 'HELPER']))) return res.status(403).json({ error: 'event_team_required' });
  const [rows] = await database.query<mysql.RowDataPacket[]>(
    `SELECT COUNT(DISTINCT o.order_id) AS paid_orders, COALESCE(SUM(i.quantity), 0) AS tickets_sold,
       COALESCE(SUM(i.quantity * i.unit_price_cents), 0) AS revenue_cents
     FROM orders o LEFT JOIN order_items i ON i.order_id = o.order_id WHERE o.event_id = ? AND o.status = 'PAID'`, [eventId],
  );
  const summary = rows[0]!;
  const paidOrders = Number(summary.paid_orders);
  const revenueCents = Number(summary.revenue_cents);
  return res.json({ paidOrders, ticketsSold: Number(summary.tickets_sold), revenueCents, averageOrderCents: paidOrders ? Math.round(revenueCents / paidOrders) : 0 });
});

app.get('/events/:eventId/attendees', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!requireDatabase(res)) return;
  const eventId = positiveInteger(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  if (!(await hasEventRole(eventId, caller.sub, ['ORGANISER']))) return res.status(403).json({ error: 'event_organiser_required' });
  const [attendees] = await database.query<mysql.RowDataPacket[]>(
    `SELECT o.order_id, o.customer_sub, o.customer_email, o.customer_name, o.paid_at, i.description, i.quantity, i.seat_id
     FROM orders o INNER JOIN order_items i ON i.order_id = o.order_id
     WHERE o.event_id = ? AND o.status = 'PAID' ORDER BY o.paid_at, o.order_id, i.order_item_id`, [eventId],
  );
  return res.json({ attendees });
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('unhandled order error', error);
  if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
});

if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(PORT, HOST, () => console.log(`${SERVICE}-service -> http://${HOST}:${PORT}`));
  const shutdown = new AbortController();
  const reservationSweep = databaseConfigured
    ? setInterval(() => {
        void expireReservations().catch((error) => console.error('reservation expiry sweep failed', { error }));
      }, RESERVATION_SWEEP_INTERVAL_MS)
    : undefined;
  reservationSweep?.unref();
  const worker = PAYMENT_REQUESTS_QUEUE_URL && databaseConfigured
    ? consumePayments(sqs, PAYMENT_REQUESTS_QUEUE_URL, (request) => processPayment(request.orderId, request.customerSub, 'simulated'), shutdown.signal)
    : Promise.resolve();
  const stop = () => {
    shutdown.abort();
    clearInterval(reservationSweep);
    server.close(() => { void worker.finally(() => database.end()); });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

export { app, database, parseCreateOrder, positiveInteger };
