import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

// Safety: nothing in this file may ever reach a real database or AWS. The pool
// and the token verifier are replaced with fakes below, and the environment
// points at hosts that cannot resolve.
process.env.NODE_ENV = 'test';
process.env.DB_HOST = 'db.invalid';
process.env.DB_PORT = '1';
process.env.DB_NAME = 'checkout';
process.env.DB_USER = 'test';
process.env.DB_PASSWORD = 'test';
process.env.COGNITO_USER_POOL_ID = 'ap-southeast-1_test';
process.env.COGNITO_CLIENT_ID = 'test-client';

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
          return { sub: token, email: `${token}@example.com` };
        },
      }),
    },
  },
});

const { app } = await import('./index.js');

describe('POST /orders sale window', () => {
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

  const EVENT_QUERY = /FROM event_inventory\.events WHERE event_id = \? LIMIT 1/;
  const scriptEvent = (overrides: Record<string, unknown> = {}) => {
    on(EVENT_QUERY, [
      { event_id: 5, organiser_sub: 'organiser', tier: 'TIER1_GA', status: 'PUBLISHED', has_started: 0, ...overrides },
    ]);
    on(/FROM event_inventory\.event_team_memberships/, []);
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

    rules = [];
    scriptEvent({ status: 'CANCELLED', has_started: 1 });
    assert.deepEqual(await placeOrder({ eventId: 5, quantity: 1 }), {
      status: 409,
      body: { error: 'event_not_on_sale' },
    });
  });

  it('lets an upcoming published event through to the normal stock check', async () => {
    scriptEvent();
    on(/FROM event_inventory\.inventory_items/, []);

    const response = await placeOrder({ eventId: 5, quantity: 1 });

    assert.deepEqual(response, { status: 409, body: { error: 'inventory_unavailable' } });
  });

  it('rejects an unauthenticated order before looking at the event', async () => {
    const response = await placeOrder({ eventId: 5, quantity: 1 }, 'bad');
    assert.equal(response.status, 401);
    assert.equal(calls.length, 0);
  });
});
