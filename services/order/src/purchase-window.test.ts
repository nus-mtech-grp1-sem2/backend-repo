import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

import { installOfflineServices, startServer, type TestServer } from '../../test-support/offline-services.js';

// Nothing here can reach a real database or AWS: see test-support/offline-services.ts.
const db = installOfflineServices(mock, {
  env: { DB_NAME: 'checkout' },
  claims: (token) => ({ sub: token, email: `${token}@example.com` }),
});
const { calls, on } = db;

const { app } = await import('./index.js');

describe('POST /orders sale window', () => {
  let server: TestServer;
  let base = '';

  before(async () => {
    server = await startServer(app);
    base = server.base;
  });
  after(() => server.close());
  beforeEach(() => {
    db.reset();
  });

  const EVENT_QUERY = /FROM event_inventory\.events WHERE event_id = \? LIMIT 1/;
  /** The caller's live admission, which both tiers need before ordering directly. */
  const ADMITTED_ENTRY = /e\.status = 'ADMITTED' AND e\.admission_token = \?/;
  const scriptEvent = (overrides: Record<string, unknown> = {}) => {
    on(/h\.expires_at <= CURRENT_TIMESTAMP.*o\.event_id = \?/, []);
    on(EVENT_QUERY, [
      { event_id: 5, organiser_sub: 'organiser', tier: 'TIER1_GA', status: 'PUBLISHED', has_started: 0, ...overrides },
    ]);
  };
  const placeOrder = async (body: unknown, token = 'alice') => {
    const response = await fetch(`${base}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const writes = () => calls.filter((call) => /^(INSERT|UPDATE|DELETE)/.test(call.sql));
  const rolledBack = () => calls.some((call) => call.sql === 'ROLLBACK');

  it('says how many tickets one order may hold when a buyer asks for more', async () => {
    for (const body of [{ eventId: 5, quantity: 60 }, { eventId: 5, quantity: 51, admissionToken: 'admitted' }]) {
      db.reset();
      assert.deepEqual(await placeOrder(body), {
        status: 400,
        body: { error: 'too_many_tickets', maxQuantity: 50 },
      });
      assert.equal(calls.length, 0, 'refused before touching the database');
    }
  });

  it('asks MySQL whether the event has started, against UTC time', async () => {
    scriptEvent();
    on(/FROM event_inventory\.inventory_items/, []);

    await placeOrder({ eventId: 5, quantity: 1 });

    const eventQuery = calls.find((call) => EVENT_QUERY.test(call.sql));
    assert.match(eventQuery?.sql ?? '', /starts_at < UTC_TIMESTAMP\(\) AS has_started/);
  });

  it('refuses to sell tickets to an event that has started, before reserving anything', async () => {
    scriptEvent({ has_started: 1 });

    const response = await placeOrder({ eventId: 5, quantity: 1 });

    assert.deepEqual(response, { status: 409, body: { error: 'event_completed' } });
    assert.ok(rolledBack());
    assert.deepEqual(writes(), [], 'no hold, stock change or order may be written');
  });

  it('refuses a completed reserved-seating event before asking for a queue admission', async () => {
    scriptEvent({ has_started: 1, tier: 'TIER2_SEATED' });

    const response = await placeOrder({ eventId: 5, quantity: 1, seatIds: [10] });

    assert.deepEqual(response, { status: 409, body: { error: 'event_completed' } });
    assert.deepEqual(writes(), []);
  });

  it('refuses to turn an existing hold into an order once the event has started', async () => {
    on(/FROM event_inventory\.inventory_holds WHERE hold_id = \?/, [
      {
        hold_id: 41,
        event_id: 5,
        inventory_item_id: 9,
        customer_sub: 'alice',
        quantity: 1,
        status: 'ACTIVE',
        expires_at: new Date(Date.now() + 60_000),
        order_id: null,
      },
    ]);
    on(/UPDATE event_inventory\.inventory_holds SET expires_at/, { affectedRows: 1 });
    scriptEvent({ has_started: 1 });

    const response = await placeOrder({ holdId: 41 });

    assert.deepEqual(response, { status: 409, body: { error: 'event_completed' } });
    assert.equal(calls.filter((call) => /INSERT INTO orders/.test(call.sql)).length, 0);
  });

  it('still refuses an event that is not published, whether or not it has started', async () => {
    scriptEvent({ status: 'DRAFT' });
    assert.deepEqual(await placeOrder({ eventId: 5, quantity: 1 }), {
      status: 409,
      body: { error: 'event_not_on_sale' },
    });

    db.clearRules();
    scriptEvent({ status: 'CANCELLED', has_started: 1 });
    assert.deepEqual(await placeOrder({ eventId: 5, quantity: 1 }), {
      status: 409,
      body: { error: 'event_not_on_sale' },
    });
  });

  it('refuses a general-admission order without a queue admission, before reserving anything', async () => {
    scriptEvent();

    const response = await placeOrder({ eventId: 5, quantity: 1 });

    assert.deepEqual(response, { status: 403, body: { error: 'queue_admission_required' } });
    assert.deepEqual(writes(), []);
  });

  it('lets an upcoming published event through to the normal stock check', async () => {
    scriptEvent();
    on(ADMITTED_ENTRY, [{ queue_entry_id: 3 }]);
    on(/FROM event_inventory\.inventory_items/, []);

    const response = await placeOrder({ eventId: 5, quantity: 1, admissionToken: 'admitted' });

    assert.deepEqual(response, { status: 409, body: { error: 'inventory_unavailable' } });
  });

  it('lets event owners and accepted team members through to the normal stock check', async () => {
    for (const token of ['organiser', 'helper']) {
      db.clearRules();
      scriptEvent();
      on(ADMITTED_ENTRY, [{ queue_entry_id: 3 }]);
      on(/FROM event_inventory\.inventory_items/, []);
      on(/FROM event_inventory\.event_team_memberships/, [{ membership_id: 9 }]);

      assert.deepEqual(await placeOrder({ eventId: 5, quantity: 1, admissionToken: 'admitted' }, token), {
        status: 409,
        body: { error: 'inventory_unavailable' },
      });
      assert.equal(
        calls.some((call) => /FROM event_inventory\.event_team_memberships/.test(call.sql)),
        false,
      );
    }
  });

  it('rejects an unauthenticated order before looking at the event', async () => {
    const response = await placeOrder({ eventId: 5, quantity: 1 }, 'bad');
    assert.equal(response.status, 401);
    assert.equal(calls.length, 0);
  });
});
