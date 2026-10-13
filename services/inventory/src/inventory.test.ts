import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type mysql from 'mysql2/promise';
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

test('GA zone capacity is set by an explicit quantity field, independent of the drawn rectangle area', async () => {
  const fixture = await createEventFixture('TIER1_GA');
  try {
    // Rectangle area = 2 * 3 = 6, but organiser sets quantity to 500.
    const putRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({
        zones: [
          { name: 'General Admission', price: 25, color: '#2563EB', gridRow: 0, gridCol: 0, gridRowSpan: 2, gridColSpan: 3, quantity: 500 },
        ],
      }),
    });
    assert.equal(putRes.status, 204);

    const getRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      headers: authHeader(fixture.organiserSub),
    });
    const { zones } = await getRes.json();
    assert.equal(zones[0].seatCount, 500);

    // A negative or non-integer quantity must be rejected.
    const badQty = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({
        zones: [
          { name: 'General Admission', price: 25, color: '#2563EB', gridRow: 0, gridCol: 0, gridRowSpan: 2, gridColSpan: 3, quantity: -1 },
        ],
      }),
    });
    assert.equal(badQty.status, 400);
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

test('a published event can still add capacity and change prices', async () => {
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
    assert.equal(putRes.status, 204);

    const getRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      headers: authHeader(fixture.organiserSub),
    });
    const getBody = await getRes.json();
    assert.equal(getBody.zones.length, 1);
    assert.equal(getBody.zones[0].seatCount, 6);
    assert.equal(getBody.zones[0].priceCents, 7500);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('a published GA zone can grow, but never shrink below what is sold or held', async () => {
  const fixture = await createEventFixture('TIER1_GA', 'PUBLISHED');
  const put = (gridColSpan: number, price: number, inventoryItemId?: number) =>
    fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({
        zones: [{ ...(inventoryItemId ? { inventoryItemId } : {}), name: 'Standing', price, color: '#00FF00', gridRow: 0, gridCol: 0, gridRowSpan: 1, gridColSpan }],
      }),
    });
  try {
    assert.equal((await put(5, 30)).status, 204);
    const [rows] = await testPool.query<mysql.RowDataPacket[]>(
      'SELECT inventory_item_id FROM inventory_items WHERE event_id = ?', [fixture.eventId],
    );
    const zoneId = rows[0]!.inventory_item_id as number;
    await testPool.execute('UPDATE inventory_items SET sold_qty = 3, reserved_qty = 1 WHERE inventory_item_id = ?', [zoneId]);

    const tooSmall = await put(3, 30, zoneId);
    assert.equal(tooSmall.status, 409);
    assert.equal((await tooSmall.json()).error, 'zone_below_allocated');

    assert.equal((await put(4, 45, zoneId)).status, 204, 'exactly the sold + held tickets is allowed');
    assert.equal((await put(8, 45, zoneId)).status, 204);
    const [after] = await testPool.query<mysql.RowDataPacket[]>(
      'SELECT total_qty, price_cents FROM inventory_items WHERE inventory_item_id = ?', [zoneId],
    );
    assert.deepEqual({ ...after[0] }, { total_qty: 8, price_cents: 4500 });
    const [events] = await testPool.query<mysql.RowDataPacket[]>('SELECT total_seats FROM events WHERE event_id = ?', [fixture.eventId]);
    assert.equal(events[0]!.total_seats, 8);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('a published event that has already started keeps its inventory', async () => {
  const fixture = await createEventFixture('TIER2_SEATED', 'PUBLISHED');
  try {
    await testPool.execute('UPDATE events SET starts_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR) WHERE event_id = ?', [fixture.eventId]);
    const putRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({
        zones: [{ name: 'Late', price: 10, color: '#0000FF', gridRow: 0, gridCol: 0, gridRowSpan: 1, gridColSpan: 1 }],
      }),
    });
    assert.equal(putRes.status, 409);
    assert.equal((await putRes.json()).error, 'event_completed');
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

test('a customer can list a GA event\'s ticket tiers with remaining capacity, without organiser access', async () => {
  const fixture = await createEventFixture('TIER1_GA', 'DRAFT');
  try {
    const putRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({
        zones: [
          { name: 'General Admission', price: 20, color: '#2563EB', gridRow: 0, gridCol: 0, gridRowSpan: 4, gridColSpan: 5 },
          { name: 'VIP', price: 50, color: '#DC2626', gridRow: 4, gridCol: 0, gridRowSpan: 2, gridColSpan: 4 },
        ],
      }),
    });
    assert.equal(putRes.status, 204);

    const getRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      headers: authHeader(fixture.organiserSub),
    });
    const { zones: seededZones } = await getRes.json();
    const gaZone = seededZones.find((z: { name: string }) => z.name === 'General Admission');
    // Sell 3 GA tickets so remaining capacity actually differs from total_qty.
    await testPool.execute('UPDATE inventory_items SET sold_qty = 3 WHERE inventory_item_id = ?', [gaZone.inventoryItemId]);
    // Zones are configured while DRAFT (PUT is locked once PUBLISHED); the
    // event goes on sale afterwards, same as the real organiser flow.
    await testPool.execute("UPDATE events SET status = 'PUBLISHED' WHERE event_id = ?", [fixture.eventId]);

    const customerRes = await fetch(`${baseUrl}/events/${fixture.eventId}/zones`, {
      headers: authHeader('some-customer-sub'),
    });
    assert.equal(customerRes.status, 200);
    const body = await customerRes.json();
    assert.equal(body.zones.length, 2);
    // So the customer can render the same zone layout the organiser painted
    // (just read-only, with no individual seats to pick) instead of a flat
    // list with no sense of where each zone sits relative to the others.
    assert.equal(body.gridRows, 6);
    assert.equal(body.gridCols, 8);

    const ga = body.zones.find((z: { name: string }) => z.name === 'General Admission');
    assert.equal(ga.priceCents, 2000);
    assert.equal(ga.color, '#2563EB');
    assert.equal(ga.remaining, 17); // 20 capacity - 3 sold
    assert.equal(ga.gridRow, 0);
    assert.equal(ga.gridCol, 0);
    assert.equal(ga.gridRowSpan, 4);
    assert.equal(ga.gridColSpan, 5);

    const vip = body.zones.find((z: { name: string }) => z.name === 'VIP');
    assert.equal(vip.priceCents, 5000);
    assert.equal(vip.remaining, 8);
    assert.equal(vip.gridRow, 4);
    assert.equal(vip.gridCol, 0);
    assert.equal(vip.gridRowSpan, 2);
    assert.equal(vip.gridColSpan, 4);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('listing ticket tiers requires authentication', async () => {
  const fixture = await createEventFixture('TIER1_GA', 'PUBLISHED');
  try {
    const res = await fetch(`${baseUrl}/events/${fixture.eventId}/zones`);
    assert.equal(res.status, 401);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('stage pieces are stored under __STAGE__ sentinel and returned separately from zones', async () => {
  const fixture = await createEventFixture('TIER2_SEATED');
  try {
    // Set up a zone first so we can verify stage pieces don't interfere with it.
    await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({ zones: [{ name: 'Stalls', price: 50, color: '#FF0000', gridRow: 2, gridCol: 0, gridRowSpan: 4, gridColSpan: 6 }] }),
    });

    const stageRes = await fetch(`${baseUrl}/events/${fixture.eventId}/stage`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({ pieces: [{ gridRow: 0, gridCol: 0, gridRowSpan: 2, gridColSpan: 6 }] }),
    });
    assert.equal(stageRes.status, 204);

    const invRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      headers: authHeader(fixture.organiserSub),
    });
    const inv = await invRes.json();
    // Stage pieces must NOT appear in the zones array.
    assert.equal(inv.zones.length, 1);
    assert.equal(inv.zones[0].name, 'Stalls');
    // Stage pieces appear in a separate stagePieces array.
    assert.equal(inv.stagePieces.length, 1);
    assert.equal(inv.stagePieces[0].gridRow, 0);
    assert.equal(inv.stagePieces[0].gridRowSpan, 2);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('__STAGE__ is reserved and cannot be used as a zone name', async () => {
  const fixture = await createEventFixture('TIER2_SEATED');
  try {
    const res = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({ zones: [{ name: '__STAGE__', price: 0, color: '#000000', gridRow: 0, gridCol: 0, gridRowSpan: 1, gridColSpan: 1 }] }),
    });
    assert.equal(res.status, 400);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('more than 5 stage pieces are rejected; stage pieces overlapping zones are rejected', async () => {
  const fixture = await createEventFixture('TIER2_SEATED');
  try {
    // Draw a zone at row 2.
    await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({ zones: [{ name: 'Stalls', price: 50, color: '#FF0000', gridRow: 2, gridCol: 0, gridRowSpan: 1, gridColSpan: 1 }] }),
    });

    // 6 pieces is over the cap of 5.
    const tooMany = await fetch(`${baseUrl}/events/${fixture.eventId}/stage`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({
        pieces: [
          { gridRow: 0, gridCol: 0, gridRowSpan: 1, gridColSpan: 1 },
          { gridRow: 0, gridCol: 1, gridRowSpan: 1, gridColSpan: 1 },
          { gridRow: 0, gridCol: 2, gridRowSpan: 1, gridColSpan: 1 },
          { gridRow: 0, gridCol: 3, gridRowSpan: 1, gridColSpan: 1 },
          { gridRow: 0, gridCol: 4, gridRowSpan: 1, gridColSpan: 1 },
          { gridRow: 0, gridCol: 5, gridRowSpan: 1, gridColSpan: 1 },
        ],
      }),
    });
    assert.equal(tooMany.status, 400);

    // A stage piece overlapping an existing zone is rejected.
    const overlaps = await fetch(`${baseUrl}/events/${fixture.eventId}/stage`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({ pieces: [{ gridRow: 2, gridCol: 0, gridRowSpan: 1, gridColSpan: 1 }] }),
    });
    assert.equal(overlaps.status, 409);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('inventory PUT leaves existing stage pieces untouched', async () => {
  const fixture = await createEventFixture('TIER2_SEATED');
  try {
    // Place a stage piece first.
    await fetch(`${baseUrl}/events/${fixture.eventId}/stage`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({ pieces: [{ gridRow: 0, gridCol: 0, gridRowSpan: 1, gridColSpan: 1 }] }),
    });

    // Now do a zone PUT — it must not wipe out the stage piece.
    const zoneRes = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({ zones: [{ name: 'Stalls', price: 50, color: '#FF0000', gridRow: 1, gridCol: 0, gridRowSpan: 1, gridColSpan: 1 }] }),
    });
    assert.equal(zoneRes.status, 204);

    const inv = await (await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      headers: authHeader(fixture.organiserSub),
    })).json();
    assert.equal(inv.stagePieces.length, 1);
    assert.equal(inv.zones.length, 1);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('reserved grid dimensions up to 20x20 are accepted; 21 in either axis is rejected', async () => {
  const fixture = await createEventFixture('TIER2_SEATED');
  try {
    const ok = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({ gridRows: 20, gridCols: 20, zones: [] }),
    });
    assert.equal(ok.status, 204);

    const tooWide = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({ gridRows: 20, gridCols: 21, zones: [] }),
    });
    assert.equal(tooWide.status, 400);

    const tooTall = await fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({ gridRows: 21, gridCols: 20, zones: [] }),
    });
    assert.equal(tooTall.status, 400);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('reserved seating accepts exactly 400 seats', async () => {
  const fixture = await createEventFixture('TIER2_SEATED');
  try {
    const request = (zones: object[]) => fetch(`${baseUrl}/events/${fixture.eventId}/inventory`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({ gridRows: 20, gridCols: 20, zones }),
    });
    const mainZone = {
      name: 'Reserved', price: 50, color: '#2563EB',
      gridRow: 0, gridCol: 0, gridRowSpan: 20, gridColSpan: 20,
    };

    assert.equal((await request([mainZone])).status, 204);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});
