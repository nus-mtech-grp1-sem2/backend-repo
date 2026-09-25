// Shared test-only setup: loads the same DB credentials the running service
// uses (repo-root .env, via the `dotenv` dependency already in package.json —
// no new test-only dependency), and gives each test a disposable event +
// inventory fixture in the real `event_inventory` schema so tests exercise
// real SQL rather than a mocked database (see mocking.md: "Databases
// (sometimes - prefer test DB)").
//
// NODE_ENV must be forced to 'test' *before* importing dotenv/config (which
// never overwrites an already-set env var) and before importing the service
// module, since index.ts only calls app.listen() when NODE_ENV !== 'test'.
process.env.NODE_ENV = 'test';

import 'dotenv/config';
import mysql from 'mysql2/promise';

export const testPool = mysql.createPool({
  host: process.env.DB_HOST ?? '',
  port: Number(process.env.DB_PORT ?? 3306),
  database: process.env.DB_NAME_EVENT_INVENTORY ?? '',
  user: process.env.DB_USER ?? '',
  password: process.env.DB_PASSWORD ?? '',
  connectionLimit: 4,
  ...(process.env.DB_SSL === 'false' ? {} : { ssl: { rejectUnauthorized: false } }),
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

export interface GaFixture {
  readonly eventId: number;
  readonly inventoryItemId: number;
  readonly totalQty: number;
}

export async function createGaFixture(totalQty = 10): Promise<GaFixture> {
  const suffix = uniqueSuffix();
  const [eventResult] = await testPool.execute<mysql.ResultSetHeader>(
    "INSERT INTO events (organiser_sub, title, venue, starts_at, tier, status) " +
      "VALUES (?, ?, 'Test Venue', DATE_ADD(NOW(), INTERVAL 7 DAY), 'TIER1_GA', 'PUBLISHED')",
    [`tdd-organiser-${suffix}`, `TDD-TEST-EVENT-${suffix}`],
  );
  const eventId = eventResult.insertId;
  const [itemResult] = await testPool.execute<mysql.ResultSetHeader>(
    'INSERT INTO inventory_items (event_id, name, total_qty, price_cents) VALUES (?, ?, ?, ?)',
    [eventId, 'General Admission', totalQty, 2500],
  );
  return { eventId, inventoryItemId: itemResult.insertId, totalQty };
}

export interface SeatedFixture {
  readonly eventId: number;
  readonly inventoryItemId: number;
  readonly seatIds: number[];
}

export async function createSeatedFixture(seatCount = 4): Promise<SeatedFixture> {
  const suffix = uniqueSuffix();
  const [eventResult] = await testPool.execute<mysql.ResultSetHeader>(
    "INSERT INTO events (organiser_sub, title, venue, starts_at, tier, status) " +
      "VALUES (?, ?, 'Test Venue', DATE_ADD(NOW(), INTERVAL 7 DAY), 'TIER2_SEATED', 'PUBLISHED')",
    [`tdd-organiser-${suffix}`, `TDD-TEST-EVENT-${suffix}`],
  );
  const eventId = eventResult.insertId;
  const [itemResult] = await testPool.execute<mysql.ResultSetHeader>(
    'INSERT INTO inventory_items (event_id, name, section_code, total_qty, price_cents) VALUES (?, ?, ?, ?, ?)',
    [eventId, 'Section A', 'A', seatCount, 5000],
  );
  const inventoryItemId = itemResult.insertId;
  const seatIds: number[] = [];
  for (let i = 0; i < seatCount; i += 1) {
    const [seatResult] = await testPool.execute<mysql.ResultSetHeader>(
      'INSERT INTO seats (event_id, inventory_item_id, seat_label, row_label, seat_number) VALUES (?, ?, ?, ?, ?)',
      [eventId, inventoryItemId, `A-A${i + 1}`, 'A', i + 1],
    );
    seatIds.push(seatResult.insertId);
  }
  return { eventId, inventoryItemId, seatIds };
}

export interface EventFixture {
  readonly eventId: number;
  readonly organiserSub: string;
}

/** A bare event with an ACCEPTED ORGANISER membership, for tests exercising
 * `requireEventOrganiser`-gated endpoints (it checks `event_team_memberships`,
 * not `events.organiser_sub`). Defaults to TIER1_GA; pass 'TIER2_SEATED' for
 * tests that need the seated-zone branch. Defaults to DRAFT status — the
 * real organiser flow configures zones/seats before publishing, and a
 * PUBLISHED event's inventory is locked (see `putZoneInventory`'s status
 * check) — pass 'PUBLISHED' explicitly for tests exercising that lock. */
export async function createEventFixture(
  tier: 'TIER1_GA' | 'TIER2_SEATED' = 'TIER1_GA',
  status: 'DRAFT' | 'PUBLISHED' | 'CANCELLED' = 'DRAFT',
): Promise<EventFixture> {
  const suffix = uniqueSuffix();
  const organiserSub = `tdd-organiser-${suffix}`;
  const [eventResult] = await testPool.execute<mysql.ResultSetHeader>(
    "INSERT INTO events (organiser_sub, title, venue, starts_at, tier, status) " +
      "VALUES (?, ?, 'Test Venue', DATE_ADD(NOW(), INTERVAL 7 DAY), ?, ?)",
    [organiserSub, `TDD-TEST-EVENT-${suffix}`, tier, status],
  );
  const eventId = eventResult.insertId;
  await testPool.execute(
    "INSERT INTO event_team_memberships (event_id, user_sub, user_email, role, invite_status, granted_by_sub) " +
      "VALUES (?, ?, ?, 'ORGANISER', 'ACCEPTED', ?)",
    [eventId, organiserSub, `${organiserSub}@test.example`, organiserSub],
  );
  return { eventId, organiserSub };
}

/** Deletes a fixture event and everything hanging off it, respecting FKs. */
export async function destroyFixture(eventId: number): Promise<void> {
  await testPool.execute('DELETE FROM event_team_memberships WHERE event_id = ?', [eventId]);
  await testPool.execute('DELETE FROM event_grid_settings WHERE event_id = ?', [eventId]);
  // seats must go before inventory_holds: a HELD seat's `hold_id` FK-references
  // the hold row, so deleting the hold first while a seat still points at it
  // fails (ER_ROW_IS_REFERENCED_2). Deleting the seat itself is unaffected by
  // its own hold_id value.
  await testPool.execute('DELETE FROM seats WHERE event_id = ?', [eventId]);
  await testPool.execute('DELETE FROM inventory_holds WHERE event_id = ?', [eventId]);
  await testPool.execute('DELETE FROM inventory_items WHERE event_id = ?', [eventId]);
  await testPool.execute('DELETE FROM events WHERE event_id = ?', [eventId]);
}
