// Shared test-only setup: loads the same DB credentials the running service
// uses (repo-root .env, via the `dotenv` dependency already in package.json —
// no new test-only dependency), and gives each test a disposable event +
// ticket fixture in the real `event_inventory`/`ticketing` schemas so tests
// exercise real SQL rather than a mocked database (see mocking.md:
// "Databases (sometimes - prefer test DB)").
//
// NODE_ENV must be forced to 'test' *before* importing dotenv/config (which
// never overwrites an already-set env var) and before importing the service
// module, since index.ts only calls app.listen() when NODE_ENV !== 'test'.
process.env.NODE_ENV = 'test';

import 'dotenv/config';
import mysql from 'mysql2/promise';

const poolOptions = {
  host: process.env.DB_HOST ?? '',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? '',
  password: process.env.DB_PASSWORD ?? '',
  connectionLimit: 4,
  ...(process.env.DB_SSL === 'false' ? {} : { ssl: { rejectUnauthorized: false } }),
};

export const eventInventoryPool = mysql.createPool({
  ...poolOptions,
  database: process.env.DB_NAME_EVENT_INVENTORY ?? '',
});

export const ticketingPool = mysql.createPool({
  ...poolOptions,
  database: process.env.DB_NAME_TICKETING ?? '',
});

export const checkoutPool = mysql.createPool({
  ...poolOptions,
  database: process.env.DB_NAME_CHECKOUT ?? '',
});

export const queuePool = mysql.createPool({
  ...poolOptions,
  database: process.env.DB_NAME_QUEUE ?? '',
});

/** A fake Cognito verifier for `__setVerifierForTests`: any token of the form
 * `test-token:<sub>` authenticates as that `sub`; anything else is rejected,
 * the same as a real bad/expired token would be. */
export const fakeVerifier = {
  verify: async (token: string) => {
    if (!token.startsWith('test-token:')) throw new Error('invalid test token');
    return { sub: token.slice('test-token:'.length) };
  },
} as unknown as null; // cast to satisfy __setVerifierForTests' `typeof verifier` param

export function authHeader(sub: string): { authorization: string } {
  return { authorization: `Bearer test-token:${sub}` };
}

let counter = 0;
/** Unique-enough id per test run so parallel test files don't collide. */
function uniqueSuffix(): string {
  counter += 1;
  return `${Date.now()}-${process.pid}-${counter}`;
}

export interface EventFixture {
  readonly eventId: number;
  readonly organiserSub: string;
}

/** Also grants `organiserSub` an ACCEPTED ORGANISER membership on the event,
 * so tests can authenticate as someone allowed through organiser-gated
 * routes (e.g. check-in stats) without a separate setup call. */
export async function createEventFixture(): Promise<EventFixture> {
  const suffix = uniqueSuffix();
  const organiserSub = `tdd-organiser-${suffix}`;
  const [eventResult] = await eventInventoryPool.execute<mysql.ResultSetHeader>(
    "INSERT INTO events (organiser_sub, title, venue, starts_at, tier, status) " +
      "VALUES (?, ?, 'Test Venue', DATE_ADD(NOW(), INTERVAL 7 DAY), 'TIER1_GA', 'PUBLISHED')",
    [organiserSub, `TDD-TEST-EVENT-${suffix}`],
  );
  const eventId = eventResult.insertId;
  await eventInventoryPool.execute(
    "INSERT INTO event_team_memberships (event_id, user_sub, user_email, role, invite_status, granted_by_sub) " +
      "VALUES (?, ?, ?, 'ORGANISER', 'ACCEPTED', ?)",
    [eventId, organiserSub, `${organiserSub}@test.example`, organiserSub],
  );
  return { eventId, organiserSub };
}

export interface OrderFixtureInput {
  readonly eventId: number;
  readonly customerSub: string;
  readonly status?: 'PENDING' | 'PAID' | 'FAILED' | 'CANCELLED';
  readonly totalAmountCents?: number;
}

/** Inserts an order directly into `checkout.orders`, bypassing the order
 * flow (not yet implemented). `hold_id` has no cross-database FK from this
 * schema but is uniquely constrained, so each fixture needs its own
 * placeholder value rather than a shared literal. */
export async function createOrderFixture(input: OrderFixtureInput): Promise<number> {
  counter += 1;
  const [result] = await checkoutPool.execute<mysql.ResultSetHeader>(
    `INSERT INTO orders
       (event_id, customer_sub, customer_email, hold_id, status, total_amount_cents, currency, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, 'SGD', ?)`,
    [
      input.eventId,
      input.customerSub,
      `${input.customerSub}@test.example`,
      Date.now() * 1000 + counter,
      input.status ?? 'PAID',
      input.totalAmountCents ?? 5000,
      input.status === 'PENDING' ? null : new Date(),
    ],
  );
  return result.insertId;
}

export interface InventoryItemFixtureInput {
  readonly eventId: number;
  readonly totalQty: number;
  readonly reservedQty?: number;
  readonly soldQty?: number;
  readonly priceCents?: number;
}

/** Inserts an inventory item directly into `event_inventory.inventory_items`,
 * so dashboard-style tests have real remaining-stock numbers to assert on. */
export async function createInventoryItemFixture(input: InventoryItemFixtureInput): Promise<number> {
  const [result] = await eventInventoryPool.execute<mysql.ResultSetHeader>(
    `INSERT INTO inventory_items (event_id, name, total_qty, reserved_qty, sold_qty, price_cents)
     VALUES (?, 'TDD Tier', ?, ?, ?, ?)`,
    [input.eventId, input.totalQty, input.reservedQty ?? 0, input.soldQty ?? 0, input.priceCents ?? 1000],
  );
  return result.insertId;
}

export interface QueueEntryFixtureInput {
  readonly eventId: number;
  readonly customerSub: string;
  readonly status?: 'WAITING' | 'ADMITTED' | 'IN_CHECKOUT' | 'EXPIRED' | 'LEFT';
}

/** Inserts a queue session (if the event doesn't have one yet) and a queue
 * entry directly into the `queue` schema, bypassing the queue service (not
 * yet implemented). */
export async function createQueueEntryFixture(input: QueueEntryFixtureInput): Promise<number> {
  const [sessionRows] = await queuePool.query<mysql.RowDataPacket[]>(
    'SELECT queue_session_id FROM queue_sessions WHERE event_id = ? LIMIT 1',
    [input.eventId],
  );
  let queueSessionId = sessionRows[0]?.queue_session_id as number | undefined;
  if (!queueSessionId) {
    const [sessionResult] = await queuePool.execute<mysql.ResultSetHeader>(
      "INSERT INTO queue_sessions (event_id, opens_at, admission_batch_size, admission_interval_sec, status) " +
        "VALUES (?, NOW(), 50, 30, 'OPEN')",
      [input.eventId],
    );
    queueSessionId = sessionResult.insertId;
  }
  counter += 1;
  const [entryResult] = await queuePool.execute<mysql.ResultSetHeader>(
    'INSERT INTO queue_entries (queue_session_id, customer_sub, position, status) VALUES (?, ?, ?, ?)',
    [queueSessionId, input.customerSub, counter, input.status ?? 'WAITING'],
  );
  return entryResult.insertId;
}

export interface TicketFixtureInput {
  readonly eventId: number;
  readonly customerSub: string;
  readonly seatId?: number | null;
  readonly status?: 'ISSUED' | 'CHECKED_IN' | 'VOID';
  readonly orderId?: number;
}

/** Inserts a ticket directly into `ticketing.tickets`, bypassing the order
 * flow (not yet implemented) since this schema has no cross-database FK on
 * order_id/order_item_id — any placeholder integer is valid, or pass a real
 * `orderId` from `createOrderFixture` when a test needs to join through to
 * `checkout.orders`. */
export async function createTicketFixture(input: TicketFixtureInput): Promise<number> {
  const suffix = uniqueSuffix();
  const [result] = await ticketingPool.execute<mysql.ResultSetHeader>(
    `INSERT INTO tickets
       (order_id, order_item_id, event_id, customer_sub, customer_email, seat_id, qr_token, status)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
    [
      input.orderId ?? 1,
      input.eventId,
      input.customerSub,
      `${input.customerSub}@test.example`,
      input.seatId ?? null,
      `tdd-qr-${suffix}`,
      input.status ?? 'ISSUED',
    ],
  );
  return result.insertId;
}

/** Deletes a fixture event and everything hanging off it, respecting FKs. */
export async function destroyFixture(eventId: number): Promise<void> {
  const [sessionRows] = await queuePool.query<mysql.RowDataPacket[]>(
    'SELECT queue_session_id FROM queue_sessions WHERE event_id = ?',
    [eventId],
  );
  for (const row of sessionRows) {
    await queuePool.execute('DELETE FROM queue_entries WHERE queue_session_id = ?', [row.queue_session_id]);
  }
  await queuePool.execute('DELETE FROM queue_sessions WHERE event_id = ?', [eventId]);
  await ticketingPool.execute('DELETE FROM tickets WHERE event_id = ?', [eventId]);
  await checkoutPool.execute('DELETE FROM orders WHERE event_id = ?', [eventId]);
  await eventInventoryPool.execute('DELETE FROM inventory_items WHERE event_id = ?', [eventId]);
  await eventInventoryPool.execute('DELETE FROM event_team_memberships WHERE event_id = ?', [eventId]);
  await eventInventoryPool.execute('DELETE FROM events WHERE event_id = ?', [eventId]);
}
