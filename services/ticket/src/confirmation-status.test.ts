import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

// Safety: nothing in this file may ever reach a real database or AWS. The pool
// and the token verifier are replaced with fakes below, and the environment
// points at hosts that cannot resolve.
process.env.NODE_ENV = 'test';
process.env.DB_HOST = 'db.invalid';
process.env.DB_PORT = '1';
process.env.DB_NAME = 'ticketing';
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

mock.module('mysql2/promise', {
  defaultExport: {
    createPool: () => ({
      query: async (sql: string, params?: readonly unknown[]) => run(sql, params),
      execute: async (sql: string, params?: readonly unknown[]) => run(sql, params),
      getConnection: async () => {
        throw new Error('no connection expected');
      },
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

const { app, confirmationEmailStatus } = await import('./index.js');

describe('confirmationEmailStatus', () => {
  it('is SENT once every issued ticket has been emailed', () => {
    assert.equal(confirmationEmailStatus(3, 3, 0), 'SENT');
    assert.equal(confirmationEmailStatus(1, 1, 0), 'SENT');
  });

  it('is PENDING until tickets exist and while emails are still going out', () => {
    assert.equal(confirmationEmailStatus(0, 0, 0), 'PENDING');
    assert.equal(confirmationEmailStatus(3, 0, 0), 'PENDING');
    assert.equal(confirmationEmailStatus(3, 2, 0), 'PENDING');
  });

  it('is FAILED only once every ticket has been attempted and one did not go out', () => {
    assert.equal(confirmationEmailStatus(3, 2, 1), 'FAILED');
    assert.equal(confirmationEmailStatus(2, 0, 2), 'FAILED');
    assert.equal(confirmationEmailStatus(3, 1, 1), 'PENDING', 'one ticket is still unattempted');
  });
});

describe('GET /customers/me/orders/:orderId/confirmation', () => {
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

  const ORDER_OWNED = /FROM checkout\.orders WHERE order_id = \? AND customer_sub = \?/;
  const TICKET_COUNT = /FROM ticketing\.tickets WHERE order_id = \?/;
  const EMAILS = /FROM notification\.email_notifications WHERE order_id = \? AND customer_sub = \?/;
  const scriptOrder = (total: number, emails: { status: string; count: number }[]) => {
    on(ORDER_OWNED, [{ order_id: 12 }]);
    on(TICKET_COUNT, [{ total }]);
    on(EMAILS, emails);
  };
  const status = async (orderId: string | number = 12, token = 'alice') => {
    const response = await fetch(`${base}/customers/me/orders/${orderId}/confirmation`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, headers: response.headers };
  };

  it('requires a signed-in customer, before touching the database', async () => {
    const anonymous = await fetch(`${base}/customers/me/orders/12/confirmation`);
    assert.equal(anonymous.status, 401);
    assert.equal((await status(12, 'bad')).status, 401);
    assert.equal(calls.length, 0);
  });

  it('rejects a malformed order id', async () => {
    for (const orderId of ['abc', '0', '-4', '1.5']) {
      assert.equal((await status(orderId)).status, 422, orderId);
    }
    assert.equal(calls.length, 0);
  });

  it("answers only for the caller's own order, and never reads emails for anyone else's", async () => {
    on(ORDER_OWNED, []);

    const response = await status(12, 'mallory');

    assert.deepEqual(response.body, { error: 'order_not_found' });
    assert.equal(response.status, 404);
    assert.deepEqual(calls[0]?.params, [12, 'mallory']);
    assert.equal(calls.filter((call) => EMAILS.test(call.sql)).length, 0);
  });

  it("filters the email records by the caller's own sub as well as the order", async () => {
    scriptOrder(1, [{ status: 'SENT', count: 1 }]);

    await status(12, 'alice');

    assert.deepEqual(calls.find((call) => EMAILS.test(call.sql))?.params, [12, 'alice']);
  });

  it('reports SENT with the counts once every ticket has been emailed', async () => {
    scriptOrder(2, [{ status: 'SENT', count: 2 }]);

    const response = await status();

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { orderId: 12, status: 'SENT', total: 2, sent: 2, failed: 0 });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('reports PENDING before any email has been recorded', async () => {
    scriptOrder(2, []);

    const response = await status();

    assert.deepEqual(response.body, { orderId: 12, status: 'PENDING', total: 2, sent: 0, failed: 0 });
  });

  it('reports PENDING while tickets are still being issued', async () => {
    scriptOrder(0, []);

    assert.equal((await status()).body['status'], 'PENDING');
  });

  it('reports FAILED when every ticket was attempted and one did not go out', async () => {
    scriptOrder(2, [
      { status: 'SENT', count: 1 },
      { status: 'FAILED', count: 1 },
    ]);

    const response = await status();

    assert.deepEqual(response.body, { orderId: 12, status: 'FAILED', total: 2, sent: 1, failed: 1 });
  });

  it('reports 502 when the database cannot be read', async () => {
    mock.method(console, 'error', () => undefined);
    on(ORDER_OWNED, new Error('connection lost'));

    const response = await status();

    assert.equal(response.status, 502);
    assert.deepEqual(response.body, { error: 'confirmation_status_failed' });
    mock.restoreAll();
  });
});
