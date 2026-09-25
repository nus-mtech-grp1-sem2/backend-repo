import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
// test-helpers MUST be imported first: it forces NODE_ENV=test and loads
// real DB creds from .env before index.ts's top-level code runs (which
// reads process.env once, at import time, to build its DB pool and decide
// whether to bind the real port).
import { fakeVerifier, authHeader, createGaFixture, createSeatedFixture, destroyFixture, testPool } from './test-helpers.js';
import { app, database, __setVerifierForTests } from './index.js';

__setVerifierForTests(fakeVerifier);

let baseUrl: string;
let server: Server;

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  const closed = new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  // fetch() keeps its connection alive by default, which stalls server.close()
  // until the keep-alive socket times out; force it closed immediately instead.
  server.closeAllConnections();
  await closed;
  await Promise.all([testPool.end(), database.end()]);
});

test('customer can create a hold for available GA inventory', async () => {
  const fixture = await createGaFixture(10);
  try {
    const res = await fetch(`${baseUrl}/events/${fixture.eventId}/holds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader('customer-1') },
      body: JSON.stringify({ inventoryItemId: fixture.inventoryItemId, quantity: 2 }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.eventId, fixture.eventId);
    assert.equal(body.inventoryItemId, fixture.inventoryItemId);
    assert.equal(body.quantity, 2);
    assert.equal(body.status, 'ACTIVE');
    assert.equal(typeof body.holdId, 'number');
    assert.ok(new Date(body.expiresAt).getTime() > Date.now());
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('customer cannot hold more than the remaining available quantity', async () => {
  const fixture = await createGaFixture(5);
  try {
    const first = await fetch(`${baseUrl}/events/${fixture.eventId}/holds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader('customer-1') },
      body: JSON.stringify({ inventoryItemId: fixture.inventoryItemId, quantity: 4 }),
    });
    assert.equal(first.status, 201);

    // Only 1 of the original 5 remains; asking for 2 must be rejected rather
    // than oversold.
    const second = await fetch(`${baseUrl}/events/${fixture.eventId}/holds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader('customer-2') },
      body: JSON.stringify({ inventoryItemId: fixture.inventoryItemId, quantity: 2 }),
    });
    assert.equal(second.status, 409);
    const body = await second.json();
    assert.equal(body.error, 'insufficient_inventory');

    const [rows] = await testPool.query(
      'SELECT reserved_qty FROM inventory_items WHERE inventory_item_id = ?',
      [fixture.inventoryItemId],
    );
    assert.equal((rows as { reserved_qty: number }[])[0]!.reserved_qty, 4);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('concurrent holds racing for the same last few tickets never oversell', async () => {
  // Only 10 tickets exist; five customers simultaneously each try to hold 3
  // (15 total demand). Without a row lock serializing these, all five could
  // read "10 available" at once and all succeed, overselling by 5. The row
  // lock in createHold (`... FOR UPDATE`) must serialize them so the sum of
  // successful holds never exceeds total_qty.
  const fixture = await createGaFixture(10);
  try {
    const attempts = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        fetch(`${baseUrl}/events/${fixture.eventId}/holds`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeader(`customer-${i}`) },
          body: JSON.stringify({ inventoryItemId: fixture.inventoryItemId, quantity: 3 }),
        }),
      ),
    );
    const succeeded = attempts.filter((r) => r.status === 201);
    // A 409 covers both "not enough left" (insufficient_inventory) and, under
    // heavy contention, "every retry hit a deadlock" (hold_contention_exceeded)
    // — neither is an oversell, both are safe-to-retry rejections.
    const rejected = attempts.filter((r) => r.status === 409);
    assert.equal(succeeded.length + rejected.length, 5);
    // At most 3 requests of qty 3 fit in 10 (3*3=9 <= 10 < 3*4=12).
    assert.ok(succeeded.length <= 3, `expected at most 3 successful holds, got ${succeeded.length}`);

    const [rows] = await testPool.query(
      'SELECT reserved_qty, total_qty FROM inventory_items WHERE inventory_item_id = ?',
      [fixture.inventoryItemId],
    );
    const row = (rows as { reserved_qty: number; total_qty: number }[])[0]!;
    assert.equal(row.reserved_qty, succeeded.length * 3);
    assert.ok(row.reserved_qty <= row.total_qty, 'reserved_qty must never exceed total_qty');
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('customer can hold specific seats for a TIER2_SEATED event', async () => {
  const fixture = await createSeatedFixture(4);
  try {
    const res = await fetch(`${baseUrl}/events/${fixture.eventId}/holds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader('customer-1') },
      body: JSON.stringify({ inventoryItemId: fixture.inventoryItemId, seatIds: fixture.seatIds.slice(0, 2) }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.quantity, 2);
    assert.deepEqual([...body.seatIds].sort(), [...fixture.seatIds.slice(0, 2)].sort());

    const [seatRows] = await testPool.query(
      'SELECT seat_id, status, hold_id FROM seats WHERE seat_id IN (?, ?)',
      fixture.seatIds.slice(0, 2),
    );
    for (const seat of seatRows as { status: string; hold_id: number }[]) {
      assert.equal(seat.status, 'HELD');
      assert.equal(seat.hold_id, body.holdId);
    }
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('customer cannot hold a seat that is already held by someone else', async () => {
  const fixture = await createSeatedFixture(4);
  try {
    const first = await fetch(`${baseUrl}/events/${fixture.eventId}/holds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader('customer-1') },
      body: JSON.stringify({ inventoryItemId: fixture.inventoryItemId, seatIds: [fixture.seatIds[0]] }),
    });
    assert.equal(first.status, 201);

    // customer-2 tries to grab the same seat plus a free one — the whole
    // request must fail atomically, not partially hold the free seat.
    const second = await fetch(`${baseUrl}/events/${fixture.eventId}/holds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader('customer-2') },
      body: JSON.stringify({ inventoryItemId: fixture.inventoryItemId, seatIds: [fixture.seatIds[0], fixture.seatIds[1]] }),
    });
    assert.equal(second.status, 409);
    const body = await second.json();
    assert.equal(body.error, 'seat_not_available');

    const [seatRow] = await testPool.query('SELECT status FROM seats WHERE seat_id = ?', [fixture.seatIds[1]]);
    assert.equal((seatRow as { status: string }[])[0]!.status, 'AVAILABLE');
  } finally {
    await destroyFixture(fixture.eventId);
  }
});
