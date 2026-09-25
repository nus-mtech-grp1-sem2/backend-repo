import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
// test-helpers MUST be imported first: it forces NODE_ENV=test and loads
// real DB creds from .env before index.ts's top-level code runs (which
// reads process.env once, at import time, to build its DB pool and decide
// whether to bind the real port).
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
  // fetch() keeps its connection alive by default, which stalls server.close()
  // until the keep-alive socket times out; force it closed immediately instead.
  server.closeAllConnections();
  await closed;
  await Promise.all([eventInventoryPool.end(), ticketingPool.end(), database.end()]);
});

test('customer can fetch their own issued tickets, but not another customer\'s', async () => {
  const fixture = await createEventFixture();
  try {
    await createTicketFixture({ eventId: fixture.eventId, customerSub: 'customer-1' });
    await createTicketFixture({ eventId: fixture.eventId, customerSub: 'customer-1', status: 'CHECKED_IN' });
    await createTicketFixture({ eventId: fixture.eventId, customerSub: 'customer-2' });

    const res = await fetch(`${baseUrl}/customers/me/tickets`, {
      headers: { ...authHeader('customer-1') },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.tickets.length, 2);
    for (const ticket of body.tickets) {
      assert.equal(ticket.event_id, fixture.eventId);
      assert.ok(['ISSUED', 'CHECKED_IN'].includes(ticket.status));
      assert.equal(typeof ticket.qr_token, 'string');
      assert.equal(typeof ticket.event_title, 'string');
    }

    await createTicketFixture({ eventId: fixture.eventId, customerSub: fixture.organiserSub });
    const organiserResponse = await fetch(`${baseUrl}/customers/me/tickets`, {
      headers: { ...authHeader(fixture.organiserSub) },
    });
    assert.equal(organiserResponse.status, 200);
    const organiserBody = await organiserResponse.json();
    assert.equal(organiserBody.tickets.length, 1);
    assert.equal(organiserBody.tickets[0].event_id, fixture.eventId);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});
