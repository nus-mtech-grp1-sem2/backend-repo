import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
// test-helpers MUST be imported first: it forces NODE_ENV=test and loads
// real DB creds from .env before index.ts's top-level code runs.
import {
  fakeVerifier,
  authHeader,
  createEventFixture,
  createOrderFixture,
  createInventoryItemFixture,
  createQueueEntryFixture,
  destroyFixture,
  checkoutPool,
  eventInventoryPool,
  ticketingPool,
  queuePool,
} from './test-helpers.js';
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
  server.closeAllConnections();
  await closed;
  await Promise.all([eventInventoryPool.end(), ticketingPool.end(), checkoutPool.end(), queuePool.end(), database.end()]);
});

test('event organiser sees live revenue, remaining inventory, and queue length for their own event', async () => {
  const fixture = await createEventFixture();
  try {
    // Customer subs scoped to this fixture's event id so this test can't
    // collide with another test file's global counts on the shared DB.
    await createOrderFixture({ eventId: fixture.eventId, customerSub: `dash-${fixture.eventId}-a`, totalAmountCents: 5000 });
    await createOrderFixture({ eventId: fixture.eventId, customerSub: `dash-${fixture.eventId}-b`, totalAmountCents: 7500 });
    await createOrderFixture({ eventId: fixture.eventId, customerSub: `dash-${fixture.eventId}-c`, status: 'FAILED', totalAmountCents: 9999 });
    await createInventoryItemFixture({ eventId: fixture.eventId, totalQty: 100, soldQty: 30, reservedQty: 5 });
    await createQueueEntryFixture({ eventId: fixture.eventId, customerSub: `dash-${fixture.eventId}-d`, status: 'WAITING' });
    await createQueueEntryFixture({ eventId: fixture.eventId, customerSub: `dash-${fixture.eventId}-e`, status: 'WAITING' });
    await createQueueEntryFixture({ eventId: fixture.eventId, customerSub: `dash-${fixture.eventId}-f`, status: 'ADMITTED' });

    const res = await fetch(`${baseUrl}/events/${fixture.eventId}/orders/summary`, {
      headers: { ...authHeader(fixture.organiserSub) },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.eventId, fixture.eventId);
    assert.equal(body.ordersPaid, 2);
    assert.equal(body.revenueCents, 12500);
    assert.equal(body.remainingInventory, 65);
    assert.equal(body.queueLength, 2);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('someone outside the event team cannot see its orders summary', async () => {
  const fixture = await createEventFixture();
  try {
    const res = await fetch(`${baseUrl}/events/${fixture.eventId}/orders/summary`, {
      headers: { ...authHeader('stranger-1') },
    });
    assert.equal(res.status, 403);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});
