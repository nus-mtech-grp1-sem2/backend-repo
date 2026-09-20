import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

// Safety: nothing in this file may ever reach a real database or AWS. The pool
// and the token verifier are replaced with fakes below, and the environment
// points at hosts that cannot resolve.
process.env.NODE_ENV = 'test';
process.env.DB_HOST = 'db.invalid';
process.env.DB_PORT = '1';
process.env.DB_NAME = 'queue';
process.env.DB_USER = 'test';
process.env.DB_PASSWORD = 'test';
process.env.COGNITO_USER_POOL_ID = 'ap-southeast-1_test';
process.env.COGNITO_CLIENT_ID = 'test-client';
process.env.INTERNAL_API_TOKEN = 'test-internal-token';
process.env.AUTO_ADMISSION_ENABLED = 'false';

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

const calls: Call[] = [];
let rules: { pattern: RegExp; response: unknown }[] = [];

/** Script the fake database: the first rule whose pattern matches a statement answers it. */
function on(pattern: RegExp, response: unknown): void {
  rules.push({ pattern, response });
}

function run(sql: string, params: readonly unknown[] = []): [unknown, unknown[]] {
  const statement = sql.replace(/\s+/g, ' ').trim();
  calls.push({ sql: statement, params });
  const rule = rules.find((candidate) => candidate.pattern.test(statement));
  if (!rule) throw new Error(`Unscripted SQL: ${statement}`);
  if (rule.response instanceof Error) throw rule.response;
  return [rule.response, []];
}

const connection = {
  beginTransaction: async () => void calls.push({ sql: 'BEGIN', params: [] }),
  commit: async () => void calls.push({ sql: 'COMMIT', params: [] }),
  rollback: async () => void calls.push({ sql: 'ROLLBACK', params: [] }),
  release: () => undefined,
  query: async (sql: string, params?: readonly unknown[]) => run(sql, params),
  execute: async (sql: string, params?: readonly unknown[]) => run(sql, params),
};

mock.module('mysql2/promise', {
  defaultExport: {
    createPool: () => ({
      query: async (sql: string, params?: readonly unknown[]) => run(sql, params),
      execute: async (sql: string, params?: readonly unknown[]) => run(sql, params),
      getConnection: async () => connection,
    }),
  },
});

// A bearer token is its own subject; "bad" fails verification.
mock.module('aws-jwt-verify', {
  namedExports: {
    CognitoJwtVerifier: {
      create: () => ({
        verify: async (token: string) => {
          if (token === 'bad') throw new Error('invalid token');
          return { sub: token };
        },
      }),
    },
  },
});

const { app, eventHasStarted } = await import('./index.js');

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

describe('waiting room for a completed event', () => {
  let server: ReturnType<typeof app.listen>;
  let base = '';

  before(async () => {
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(() => server.close());
  beforeEach(() => {
    calls.length = 0;
    rules = [];
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
