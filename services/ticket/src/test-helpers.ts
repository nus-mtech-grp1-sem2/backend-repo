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
}

export async function createEventFixture(): Promise<EventFixture> {
  const suffix = uniqueSuffix();
  const [eventResult] = await eventInventoryPool.execute<mysql.ResultSetHeader>(
    "INSERT INTO events (organiser_sub, title, venue, starts_at, tier, status) " +
      "VALUES (?, ?, 'Test Venue', DATE_ADD(NOW(), INTERVAL 7 DAY), 'TIER1_GA', 'PUBLISHED')",
    [`tdd-organiser-${suffix}`, `TDD-TEST-EVENT-${suffix}`],
  );
  return { eventId: eventResult.insertId };
}

export interface TicketFixtureInput {
  readonly eventId: number;
  readonly customerSub: string;
  readonly seatId?: number | null;
  readonly status?: 'ISSUED' | 'CHECKED_IN' | 'VOID';
}

/** Inserts a ticket directly into `ticketing.tickets`, bypassing the order
 * flow (not yet implemented) since this schema has no cross-database FK on
 * order_id/order_item_id — any placeholder integer is valid. */
export async function createTicketFixture(input: TicketFixtureInput): Promise<number> {
  const suffix = uniqueSuffix();
  const [result] = await ticketingPool.execute<mysql.ResultSetHeader>(
    `INSERT INTO tickets
       (order_id, order_item_id, event_id, customer_sub, customer_email, seat_id, qr_token, status)
     VALUES (1, 1, ?, ?, ?, ?, ?, ?)`,
    [
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
  await ticketingPool.execute('DELETE FROM tickets WHERE event_id = ?', [eventId]);
  await eventInventoryPool.execute('DELETE FROM events WHERE event_id = ?', [eventId]);
}
