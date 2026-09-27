import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
// test-helpers MUST be imported first: it forces NODE_ENV=test and loads
// real DB creds from .env before index.ts's top-level code runs (which
// reads process.env once, at import time, to build its DB pool and decide
// whether to bind the real port).
import { fakeVerifier, authHeader, createEventFixture, destroyFixture, testPool } from './test-helpers.js';
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

test('organiser drags a rectangle to create a seated zone; seats are generated automatically', async () => {
  const fixture = await createEventFixture('TIER2_SEATED');
  try {
    const putRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({
        zones: [
          { name: 'Front Stalls', price: 75, color: '#FF0000', gridRow: 0, gridCol: 0, gridRowSpan: 2, gridColSpan: 3 },
        ],
      }),
    });
    assert.equal(putRes.status, 204);

    const getRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      headers: authHeader(fixture.organiserSub),
    });
    assert.equal(getRes.status, 200);
    const body = await getRes.json();

    assert.equal(body.zones.length, 1);
    const zone = body.zones[0];
    assert.equal(zone.name, 'Front Stalls');
    assert.equal(zone.priceCents, 7500);
    assert.equal(zone.color, '#FF0000');
    assert.equal(zone.gridRow, 0);
    assert.equal(zone.gridCol, 0);
    assert.equal(zone.gridRowSpan, 2);
    assert.equal(zone.gridColSpan, 3);
    // 2 rows x 3 cols = 6 seats, generated without the client ever listing them.
    assert.equal(zone.seatCount, 6);

    assert.equal(body.seats.length, 6);
    const bySeatLabel = new Map(body.seats.map((s: { seatLabel: string }) => [s.seatLabel, s]));
    for (const label of ['A1', 'A2', 'A3', 'B1', 'B2', 'B3']) {
      assert.equal((bySeatLabel.get(label) as { inventoryItemId: number }).inventoryItemId, zone.inventoryItemId);
    }

    // Customer-facing seat map must line up exactly with the derived rectangle.
    const customerRes = await fetch(`${baseUrl}/events/${fixture.eventId}/seats`, {
      headers: authHeader(fixture.organiserSub),
    });
    assert.equal(customerRes.status, 200);
    const customerBody = await customerRes.json();
    assert.equal(customerBody.seats.length, 6);
    const customerSeat = customerBody.seats.find((s: { seatLabel: string }) => s.seatLabel === 'B3');
    assert.equal(customerSeat.gridRow, 1);
    assert.equal(customerSeat.gridCol, 2);
    assert.equal(customerSeat.priceCents, 7500);
    assert.equal(customerSeat.color, '#FF0000');
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('organiser drags a rectangle to create a GA zone; capacity is the rectangle area and no seats are created', async () => {
  const fixture = await createEventFixture('TIER1_GA');
  try {
    const putRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({
        zones: [
          { name: 'General Admission', price: 25, color: '#2563EB', gridRow: 0, gridCol: 0, gridRowSpan: 2, gridColSpan: 3 },
        ],
      }),
    });
    assert.equal(putRes.status, 204);

    const getRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      headers: authHeader(fixture.organiserSub),
    });
    assert.equal(getRes.status, 200);
    const body = await getRes.json();

    assert.equal(body.zones.length, 1);
    const zone = body.zones[0];
    // 2 rows x 3 cols = 6 capacity, with zero individual seat rows.
    assert.equal(zone.seatCount, 6);
    assert.equal(body.seats.length, 0);

    const [seatRows] = await testPool.query(
      'SELECT COUNT(*) AS total FROM seats WHERE inventory_item_id = ?',
      [zone.inventoryItemId],
    );
    assert.equal((seatRows as { total: number }[])[0]!.total, 0);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('a GA zone with sales reports soldCount/heldCount from inventory_items, not the empty seats table', async () => {
  const fixture = await createEventFixture('TIER1_GA');
  try {
    const putRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({
        zones: [
          { name: 'General Admission', price: 25, color: '#2563EB', gridRow: 0, gridCol: 0, gridRowSpan: 2, gridColSpan: 3 },
        ],
      }),
    });
    assert.equal(putRes.status, 204);

    const { zones } = await (await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      headers: authHeader(fixture.organiserSub),
    })).json();
    const inventoryItemId = zones[0].inventoryItemId;

    // A GA sale/hold updates inventory_items directly — there are no seat rows
    // to derive counts from, unlike a seated zone.
    await testPool.execute(
      'UPDATE inventory_items SET sold_qty = 1, reserved_qty = 2 WHERE inventory_item_id = ?',
      [inventoryItemId],
    );

    const getRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      headers: authHeader(fixture.organiserSub),
    });
    const body = await getRes.json();
    const zone = body.zones[0];
    assert.equal(zone.seatCount, 6);
    assert.equal(zone.soldCount, 1);
    assert.equal(zone.heldCount, 2);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('shrinking capacity below available_buyers is rejected with a clear error, not a 502', async () => {
  const fixture = await createEventFixture('TIER1_GA');
  try {
    const putRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({
        zones: [
          { name: 'General Admission', price: 25, color: '#2563EB', gridRow: 0, gridCol: 0, gridRowSpan: 2, gridColSpan: 5 },
        ],
      }),
    });
    assert.equal(putRes.status, 204);

    // available_buyers is normally set when the event is created; simulate
    // that directly rather than duplicating the event service's logic.
    await testPool.execute('UPDATE events SET available_buyers = 8 WHERE event_id = ?', [fixture.eventId]);

    const shrinkRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({
        zones: [
          { name: 'General Admission', price: 25, color: '#2563EB', gridRow: 0, gridCol: 0, gridRowSpan: 1, gridColSpan: 5 },
        ],
      }),
    });
    assert.equal(shrinkRes.status, 409);
    const shrinkBody = await shrinkRes.json();
    assert.equal(shrinkBody.error, 'capacity_below_available_buyers');
    assert.equal(shrinkBody.availableBuyers, 8);

    // The rejected shrink wrote nothing — capacity is exactly what it was.
    const [eventRows] = await testPool.query('SELECT total_seats FROM events WHERE event_id = ?', [fixture.eventId]);
    assert.equal((eventRows as { total_seats: number }[])[0]!.total_seats, 10);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('overlapping zone rectangles are rejected — each cell belongs to at most one zone', async () => {
  const fixture = await createEventFixture('TIER2_SEATED');
  try {
    const putRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({
        zones: [
          { name: 'Front Stalls', price: 75, color: '#FF0000', gridRow: 0, gridCol: 0, gridRowSpan: 2, gridColSpan: 2 },
          // Shares cell (1,1) with the zone above.
          { name: 'Balcony', price: 40, color: '#00FF00', gridRow: 1, gridCol: 1, gridRowSpan: 2, gridColSpan: 2 },
        ],
      }),
    });
    assert.equal(putRes.status, 400);

    // Nothing was written — a clean retry with non-overlapping zones works.
    const getRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      headers: authHeader(fixture.organiserSub),
    });
    const body = await getRes.json();
    assert.equal(body.zones.length, 0);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('a published event\'s inventory is locked — no zone changes are accepted', async () => {
  const fixture = await createEventFixture('TIER2_SEATED', 'PUBLISHED');
  try {
    const putRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({
        zones: [
          { name: 'Front Stalls', price: 75, color: '#FF0000', gridRow: 0, gridCol: 0, gridRowSpan: 2, gridColSpan: 3 },
        ],
      }),
    });
    assert.equal(putRes.status, 409);
    const body = await putRes.json();
    assert.equal(body.error, 'event_already_published');

    // Nothing was written.
    const getRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      headers: authHeader(fixture.organiserSub),
    });
    const getBody = await getRes.json();
    assert.equal(getBody.zones.length, 0);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('a zone with a sold seat has its rectangle frozen, but name/price/colour and other zones stay editable', async () => {
  const fixture = await createEventFixture('TIER2_SEATED');
  try {
    const putRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({
        zones: [{ name: 'Balcony', price: 40, color: '#00FF00', gridRow: 0, gridCol: 0, gridRowSpan: 1, gridColSpan: 2 }],
      }),
    });
    assert.equal(putRes.status, 204);

    const getRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      headers: authHeader(fixture.organiserSub),
    });
    const { zones, seats } = await getRes.json();
    const inventoryItemId = zones[0].inventoryItemId;
    const soldSeat = seats.find((s: { seatLabel: string }) => s.seatLabel === 'A1');

    await testPool.execute("UPDATE seats SET status = 'SOLD' WHERE seat_id = ?", [soldSeat.seatId]);

    // Attempt to resize the zone that now has a sold seat — rejected.
    const badPutRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({
        zones: [
          { inventoryItemId, name: 'Balcony', price: 40, color: '#00FF00', gridRow: 0, gridCol: 0, gridRowSpan: 1, gridColSpan: 3 },
        ],
      }),
    });
    assert.equal(badPutRes.status, 409);
    const badBody = await badPutRes.json();
    assert.equal(badBody.error, 'cannot_modify_committed_seat');

    // Same rectangle, but renamed/repriced and a brand new non-overlapping
    // zone added — allowed.
    const okPutRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({
        zones: [
          { inventoryItemId, name: 'Balcony Renamed', price: 45, color: '#00FF00', gridRow: 0, gridCol: 0, gridRowSpan: 1, gridColSpan: 2 },
          { name: 'Front Stalls', price: 75, color: '#FF0000', gridRow: 1, gridCol: 0, gridRowSpan: 1, gridColSpan: 2 },
        ],
      }),
    });
    assert.equal(okPutRes.status, 204);

    const finalGetRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      headers: authHeader(fixture.organiserSub),
    });
    const finalBody = await finalGetRes.json();
    const balcony = finalBody.zones.find((z: { inventoryItemId: number }) => z.inventoryItemId === inventoryItemId);
    assert.equal(balcony.name, 'Balcony Renamed');
    assert.equal(balcony.priceCents, 4500);
    assert.equal(balcony.seatCount, 2);
    assert.equal(finalBody.zones.length, 2);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('a zone with only expired/released hold history cannot be dropped — 409, not a 502 FK crash', async () => {
  const fixture = await createEventFixture('TIER2_SEATED');
  try {
    const putRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({
        zones: [{ name: 'Balcony', price: 40, color: '#00FF00', gridRow: 0, gridCol: 0, gridRowSpan: 1, gridColSpan: 2 }],
      }),
    });
    assert.equal(putRes.status, 204);

    const getRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      headers: authHeader(fixture.organiserSub),
    });
    const { zones } = await getRes.json();
    const inventoryItemId = zones[0].inventoryItemId;

    // No seat is SOLD/HELD (so `checkCommittedZonesUnchanged` doesn't block the
    // drop), but a past reservation attempt left a hold row referencing this
    // zone — released/expired long ago, never cleaned up. `inventory_holds`
    // still FK-references the zone, so deleting it would otherwise crash.
    await testPool.execute(
      "INSERT INTO inventory_holds (event_id, inventory_item_id, customer_sub, quantity, status, expires_at) " +
        "VALUES (?, ?, 'expired-customer', 1, 'EXPIRED', DATE_SUB(NOW(), INTERVAL 1 DAY))",
      [fixture.eventId, inventoryItemId],
    );

    // Submitting a layout that drops this zone must be rejected clearly, not
    // crash with a 502 when MySQL blocks the DELETE.
    const dropRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({ zones: [] }),
    });
    assert.equal(dropRes.status, 409);
    const dropBody = await dropRes.json();
    assert.equal(dropBody.error, 'zone_has_reservation_history');

    // Nothing was touched — the zone and its seat both still exist.
    const finalGetRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      headers: authHeader(fixture.organiserSub),
    });
    const finalBody = await finalGetRes.json();
    assert.equal(finalBody.zones.length, 1);
    assert.equal(finalBody.zones[0].inventoryItemId, inventoryItemId);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});
