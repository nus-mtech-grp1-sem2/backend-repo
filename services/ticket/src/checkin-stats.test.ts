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
  createTicketFixture,
  destroyFixture,
  eventInventoryPool,
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
  await Promise.all([eventInventoryPool.end(), ticketingPool.end(), database.end()]);
});

test('event organiser sees how many sold tickets have checked in', async () => {
  const fixture = await createEventFixture();
  try {
    // Customer subs are scoped to this fixture's event id, not shared literals
    // like "customer-1" - GET /customers/me/tickets (tickets.test.ts) looks up
    // a customer's tickets across *all* events, so a shared literal here would
    // silently inflate that other test's count when both files run against the
    // same real DB in the same test run.
    await createTicketFixture({ eventId: fixture.eventId, customerSub: `checkin-${fixture.eventId}-a`, status: 'CHECKED_IN' });
    await createTicketFixture({ eventId: fixture.eventId, customerSub: `checkin-${fixture.eventId}-b`, status: 'ISSUED' });
    await createTicketFixture({ eventId: fixture.eventId, customerSub: `checkin-${fixture.eventId}-c`, status: 'ISSUED' });

    const res = await fetch(`${baseUrl}/events/${fixture.eventId}/checkin-stats`, {
      headers: { ...authHeader(fixture.organiserSub) },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.eventId, fixture.eventId);
    assert.equal(body.ticketsSold, 3);
    assert.equal(body.checkedIn, 1);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('someone outside the event team cannot see its check-in stats', async () => {
  const fixture = await createEventFixture();
  try {
    const res = await fetch(`${baseUrl}/events/${fixture.eventId}/checkin-stats`, {
      headers: { ...authHeader('stranger-1') },
    });
    assert.equal(res.status, 403);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});
