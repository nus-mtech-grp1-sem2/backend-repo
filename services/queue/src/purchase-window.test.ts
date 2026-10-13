import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

import { installOfflineServices, startServer, type TestServer } from '../../test-support/offline-services.js';

// Nothing here can reach a real database or AWS: see test-support/offline-services.ts.
const db = installOfflineServices(mock, {
  env: { DB_NAME: 'queue', INTERNAL_API_TOKEN: 'test-internal-token', AUTO_ADMISSION_ENABLED: 'false' },
  claims: (token) => ({ sub: token }),
});
const { calls, on } = db;

const { app, assertEventOnSale, eventHasStarted, keepsQueuePlace } = await import('./index.js');

describe('eventHasStarted', () => {
  it('is true only when MySQL reports the start time as passed', () => {
    assert.equal(eventHasStarted({ has_started: 1 }), true);
    assert.equal(eventHasStarted({ has_started: 0 }), false);
  });

  it('is false when the flag or the event is missing', () => {
    assert.equal(eventHasStarted({}), false);
    assert.equal(eventHasStarted({ has_started: null }), false);
    assert.equal(eventHasStarted(undefined), false);
  });
});

describe('assertEventOnSale', () => {
  // TypeScript only lets an assertion function be called through an explicitly typed name.
  const assertOnSale: (event: Record<string, unknown> | undefined) => void = assertEventOnSale;
  const codeOf = (event: Record<string, unknown> | undefined) => {
    try {
      assertOnSale(event);
      return null;
    } catch (error) {
      return (error as { status: number; code: string }).status === 409
        ? (error as { code: string }).code
        : 'unexpected';
    }
  };

  it('passes a published event that has not started', () => {
    assert.equal(codeOf({ status: 'PUBLISHED', has_started: 0 }), null);
  });

  it('refuses a missing or unpublished event as not on sale', () => {
    assert.equal(codeOf(undefined), 'event_not_on_sale');
    assert.equal(codeOf({ status: 'DRAFT', has_started: 0 }), 'event_not_on_sale');
    assert.equal(codeOf({ status: 'CANCELLED', has_started: 1 }), 'event_not_on_sale');
  });

  it('refuses a published event that has started as completed', () => {
    assert.equal(codeOf({ status: 'PUBLISHED', has_started: 1 }), 'event_completed');
  });
});

describe('keepsQueuePlace', () => {
  const entry = (status: string, expiresInMs: number | null) =>
    ({
      queue_entry_id: 1,
      position: 3,
      status,
      admission_token: null,
      token_expires_at: expiresInMs === null ? null : new Date(Date.now() + expiresInMs),
    }) as Parameters<typeof keepsQueuePlace>[0];

  it('keeps the place of someone waiting, whatever the token field says', () => {
    assert.equal(keepsQueuePlace(entry('WAITING', null)), true);
  });

  it('keeps the place of an admitted or in-checkout customer whose token is still valid', () => {
    assert.equal(keepsQueuePlace(entry('ADMITTED', 60_000)), true);
    assert.equal(keepsQueuePlace(entry('IN_CHECKOUT', 60_000)), true);
    assert.equal(keepsQueuePlace(entry('ADMITTED', null)), true);
  });

  it('does not keep the place of an admitted or in-checkout customer whose token has expired', () => {
    assert.equal(keepsQueuePlace(entry('ADMITTED', -1_000)), false);
    assert.equal(keepsQueuePlace(entry('IN_CHECKOUT', -1_000)), false);
  });

  it('does not keep the place of someone who expired or left', () => {
    assert.equal(keepsQueuePlace(entry('EXPIRED', null)), false);
    assert.equal(keepsQueuePlace(entry('LEFT', 60_000)), false);
  });
});

describe('waiting room for a completed event', () => {
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

  const writes = () => calls.filter((call) => /^(INSERT|UPDATE|DELETE)/.test(call.sql));
  const rolledBack = () => calls.some((call) => call.sql === 'ROLLBACK');

  describe('POST /events/:eventId/queue/join', () => {
    const EVENT_QUERY = /FROM event_inventory\.events WHERE event_id = \? LIMIT 1/;
    const join = async (token = 'alice') => {
      const response = await fetch(`${base}/events/5/queue/join`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    it('asks MySQL whether the event has started, against UTC time', async () => {
      on(EVENT_QUERY, [{ has_started: 1 }]);

      await join();

      assert.match(calls.find((call) => EVENT_QUERY.test(call.sql))?.sql ?? '', /starts_at < UTC_TIMESTAMP\(\) AS has_started/);
    });

    it('refuses to let anyone join once the event has started, without touching the queue', async () => {
      on(EVENT_QUERY, [{ has_started: 1 }]);

      const response = await join();

      assert.deepEqual(response, { status: 409, body: { error: 'event_completed' } });
      assert.ok(rolledBack());
      assert.deepEqual(writes(), [], 'no queue entry may be written');
      assert.equal(calls.filter((call) => /queue_sessions/.test(call.sql)).length, 0);
    });

    it('still lets someone join the waiting room of an upcoming event', async () => {
      on(EVENT_QUERY, [{ has_started: 0 }]);
      on(/FROM queue_sessions WHERE event_id = \?/, [
        { queue_session_id: 1, opens_at: new Date(Date.now() - 60_000), status: 'OPEN' },
      ]);
      on(/FROM queue_entries WHERE queue_session_id = \? AND customer_sub = \?/, []);
      on(/COALESCE\(MAX\(position\), 0\) \+ 1/, [{ next_position: 1 }]);
      on(/INSERT INTO queue_entries/, { insertId: 9 });

      const response = await join();

      assert.equal(response.status, 201);
      assert.equal(writes().length, 1);
    });

    const openUpcomingQueue = (entries: unknown[]) => {
      on(EVENT_QUERY, [{ has_started: 0 }]);
      on(/FROM queue_sessions WHERE event_id = \?/, [
        { queue_session_id: 1, opens_at: new Date(Date.now() - 60_000), status: 'OPEN' },
      ]);
      on(/FROM queue_entries WHERE queue_session_id = \? AND customer_sub = \?/, entries);
    };

    const scriptSession = (status: string, opensInMs: number) => {
      on(EVENT_QUERY, [{ has_started: 0 }]);
      on(/FROM queue_sessions WHERE event_id = \?/, [
        { queue_session_id: 1, opens_at: new Date(Date.now() + opensInMs), status },
      ]);
      on(/FROM queue_entries WHERE queue_session_id = \? AND customer_sub = \?/, []);
      on(/COALESCE\(MAX\(position\), 0\) \+ 1/, [{ next_position: 1 }]);
      on(/INSERT INTO queue_entries/, { insertId: 9 });
      on(/UPDATE queue_sessions SET status = 'OPEN'/, {});
    };

    it('refuses to join a waiting room that is closed and not yet due to open', async () => {
      scriptSession('CLOSED', 60_000);

      const response = await join();

      assert.deepEqual(response, { status: 409, body: { error: 'queue_not_open' } });
      assert.ok(rolledBack());
      assert.deepEqual(writes(), []);
    });

    it('opens a closed waiting room whose scheduled time has come, then lets the customer join', async () => {
      scriptSession('CLOSED', -1_000);

      const response = await join();

      assert.equal(response.status, 201);
      assert.match(writes()[0]?.sql ?? '', /UPDATE queue_sessions SET status = 'OPEN'/);
      assert.equal(writes().length, 2, 'the session is opened, then the customer is queued');
    });

    it('reports a drained waiting room as sold out, and any other state as not open', async () => {
      scriptSession('DRAINED', -60_000);
      assert.deepEqual(await join(), { status: 409, body: { error: 'queue_drained' } });

      db.clearRules();
      scriptSession('PAUSED', -60_000);
      assert.deepEqual(await join(), { status: 409, body: { error: 'queue_not_open' } });
    });

    it("returns a customer's existing place without changing the queue", async () => {
      openUpcomingQueue([
        { queue_entry_id: 9, position: 4, status: 'WAITING', admission_token: null, token_expires_at: null },
      ]);

      const response = await join();

      assert.equal(response.status, 200);
      assert.deepEqual(writes(), []);
      assert.ok(calls.some((call) => call.sql === 'COMMIT'));
    });

    it('puts an admitted customer whose token expired back at the end of the queue', async () => {
      openUpcomingQueue([
        {
          queue_entry_id: 9,
          position: 1,
          status: 'ADMITTED',
          admission_token: 'old-token',
          token_expires_at: new Date(Date.now() - 1_000),
        },
      ]);
      on(/COALESCE\(MAX\(position\), 0\) \+ 1/, [{ next_position: 7 }]);
      on(/UPDATE queue_entries SET position = \?/, {});

      const response = await join();

      assert.equal(response.status, 201);
      assert.deepEqual(writes().map((call) => call.params), [[7, 9]]);
    });

    it('rejects an unauthenticated join before looking at the event', async () => {
      const response = await join('bad');
      assert.equal(response.status, 401);
      assert.equal(calls.length, 0);
    });
  });

  describe('POST /events/:eventId/queue/admit-next', () => {
    const scriptAdmission = (event: Record<string, unknown>) => {
      on(/FROM queue_sessions WHERE event_id = \? LIMIT 1 FOR UPDATE/, [
        { queue_session_id: 1, admission_interval_sec: 60, status: 'OPEN' },
      ]);
      on(/MAX\(admitted_at\)/, [{ last_admitted_at: null }]);
      on(/FROM event_inventory\.events e WHERE e\.event_id = \?/, [
        { status: 'PUBLISHED', tier: 'TIER1_GA', total_seats: 10, available_buyers: null, available_qty: 5, ...event },
      ]);
    };
    const admit = async () => {
      const response = await fetch(`${base}/events/5/queue/admit-next`, {
        method: 'POST',
        headers: { 'x-internal-token': 'test-internal-token' },
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    it('refuses to admit customers into an event that has started', async () => {
      scriptAdmission({ has_started: 1 });

      const response = await admit();

      assert.deepEqual(response, { status: 409, body: { error: 'event_completed' } });
      assert.ok(rolledBack());
      assert.deepEqual(writes(), [], 'no customer may be admitted');
    });

    it('reports a completed event as completed even when it is also sold out', async () => {
      scriptAdmission({ has_started: 1, available_qty: 0 });

      const response = await admit();

      assert.deepEqual(response, { status: 409, body: { error: 'event_completed' } });
      assert.equal(calls.filter((call) => /DRAINED/.test(call.sql)).length, 0, 'the queue must not be drained');
    });

    it('still reports an unpublished event as not on sale', async () => {
      scriptAdmission({ status: 'DRAFT', has_started: 0 });

      const response = await admit();

      assert.deepEqual(response, { status: 409, body: { error: 'event_not_on_sale' } });
    });
  });
});

describe('PUT /events/:eventId/queue/config', () => {
  let server: TestServer;
  before(async () => { server = await startServer(app); });
  after(() => server.close());
  beforeEach(() => db.reset());

  it('sets up a queue for a general-admission event, sized to its tickets, like a seated one', async () => {
    on(/FROM event_inventory\.event_team_memberships/, [{ membership_id: 1 }]);
    on(/SELECT tier, total_seats, available_buyers FROM event_inventory\.events/, [
      { tier: 'TIER1_GA', total_seats: 200, available_buyers: 40 },
    ]);
    on(/INSERT INTO queue_sessions/, { affectedRows: 1 });
    on(/FROM queue_sessions WHERE event_id = \?/, [{ queue_session_id: 9, event_id: 5 }]);

    const response = await fetch(`${server.base}/events/5/queue/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: 'Bearer organiser' },
      body: JSON.stringify({ opensAt: '2030-01-01T10:00:00Z', admissionBatchSize: 10, admissionIntervalSec: 30 }),
    });

    assert.equal(response.status, 200);
    const insert = calls.find((call) => /INSERT INTO queue_sessions/.test(call.sql));
    assert.equal(insert?.params[2], 40, 'admits at most the configured available buyers at once');
  });

  it('opens a high-capacity general-admission queue without rejecting its derived batch size', async () => {
    on(/FROM event_inventory\.event_team_memberships/, [{ membership_id: 1 }]);
    on(/SELECT tier, total_seats, available_buyers FROM event_inventory\.events/, [
      { tier: 'TIER1_GA', total_seats: 1_000_000, available_buyers: null },
    ]);
    on(/INSERT INTO queue_sessions/, { affectedRows: 1 });
    on(/FROM queue_sessions WHERE event_id = \?/, [{ queue_session_id: 10, event_id: 5 }]);

    const response = await fetch(`${server.base}/events/5/queue/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: 'Bearer organiser' },
      body: JSON.stringify({
        opensAt: '2030-01-01T10:00:00Z',
        admissionBatchSize: 100_000,
        admissionIntervalSec: 60,
      }),
    });

    assert.equal(response.status, 200);
    const insert = calls.find((call) => /INSERT INTO queue_sessions/.test(call.sql));
    assert.equal(insert?.params[2], 100_000, 'uses the server-derived 10% buyer capacity');
  });
});
