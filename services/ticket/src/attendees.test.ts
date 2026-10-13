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
  createTicketFixture,
  destroyFixture,
  checkoutPool,
  eventInventoryPool,
  queuePool,
  ticketingPool,
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

test('event organiser can view attendee contact info and order details for their own event', async () => {
  const fixture = await createEventFixture();
  try {
    // Customer sub scoped to this fixture's event id (not a shared literal)
    // so this test can't inflate another test file's global ticket/order
    // counts when both run against the same real DB in one test run.
    const customerSub = `attendee-${fixture.eventId}-a`;
    const orderId = await createOrderFixture({ eventId: fixture.eventId, customerSub, totalAmountCents: 12000 });
    await createTicketFixture({ eventId: fixture.eventId, customerSub, orderId });

    const res = await fetch(`${baseUrl}/events/${fixture.eventId}/attendees`, {
      headers: { ...authHeader(fixture.organiserSub) },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.eventId, fixture.eventId);
    assert.equal(body.attendees.length, 1);
    const [attendee] = body.attendees;
    assert.equal(attendee.customer_email, `${customerSub}@test.example`);
    assert.equal(attendee.order_id, orderId);
    assert.equal(attendee.order_status, 'PAID');
    assert.equal(attendee.total_amount_cents, 12000);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('someone outside the event team cannot see its attendee list', async () => {
  const fixture = await createEventFixture();
  try {
    const res = await fetch(`${baseUrl}/events/${fixture.eventId}/attendees`, {
      headers: { ...authHeader('stranger-1') },
    });
    assert.equal(res.status, 403);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});
