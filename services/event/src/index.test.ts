import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

// Safety: nothing in this file may ever reach a real database or AWS. The pool,
// the token verifier and the Cognito client are all replaced with fakes below,
// and the environment points at hosts that cannot resolve.
process.env.DB_HOST = 'db.invalid';
process.env.DB_PORT = '1';
process.env.DB_NAME = 'event_inventory';
process.env.DB_USER = 'test';
process.env.DB_PASSWORD = 'test';
process.env.COGNITO_USER_POOL_ID = 'ap-southeast-1_test';
process.env.COGNITO_CLIENT_ID = 'test-client';

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}
type Response = unknown;

const calls: Call[] = [];
let rules: { pattern: RegExp; response: Response }[] = [];

/** Script the fake database: the first rule whose pattern matches a statement answers it. */
function on(pattern: RegExp, response: Response): void {
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

class ListUsersCommand {
  constructor(readonly input: Record<string, unknown>) {}
}
class AdminGetUserCommand {
  constructor(readonly input: Record<string, unknown>) {}
}
const cognitoSend = mock.fn(async (_command: unknown): Promise<unknown> => ({}));
mock.module('@aws-sdk/client-cognito-identity-provider', {
  namedExports: {
    CognitoIdentityProviderClient: class {
      send = cognitoSend;
    },
    ListUsersCommand,
    AdminGetUserCommand,
  },
});

const { app, parseEventInput, parsePriceCents, validEventId } = await import('./index.js');

describe('parsePriceCents', () => {
  it('converts dollars to cents', () => {
    assert.equal(parsePriceCents(25), 2500);
    assert.equal(parsePriceCents('19.99'), 1999);
    assert.equal(parsePriceCents(0), 0);
  });

  it('is null when there is no price', () => {
    assert.equal(parsePriceCents(undefined), null);
  });

  it('rejects negative, non-numeric, oversized and sub-cent prices', () => {
    assert.equal(parsePriceCents(-1), null);
    assert.equal(parsePriceCents('abc'), null);
    assert.equal(parsePriceCents(null), null);
    assert.equal(parsePriceCents(1_000_001), null);
    assert.equal(parsePriceCents(10.005), null);
  });
});

describe('validEventId', () => {
  it('accepts positive integers', () => {
    assert.equal(validEventId('12'), 12);
  });

  it('rejects zero, negatives, fractions and non-numbers', () => {
    for (const value of ['0', '-3', '1.5', 'abc', '']) assert.equal(validEventId(value), null, value);
  });
});

describe('parseEventInput', () => {
  const valid = {
    title: 'Event NUS',
    description: 'A night',
    venue: 'NUS ISS',
    startsAt: '2027-09-17T00:23',
    totalSeats: 100,
    availableBuyers: 10,
    tier: 'TIER1_GA',
    price: 25,
  };

  it('accepts a complete event and converts the price to cents', () => {
    assert.deepEqual(parseEventInput(valid), {
      title: 'Event NUS',
      description: 'A night',
      venue: 'NUS ISS',
      startsAt: '2027-09-17T00:23',
      totalSeats: 100,
      availableBuyers: 10,
      tier: 'TIER1_GA',
      priceCents: 2500,
    });
  });

  it('trims text, and treats a blank description or missing buyers as null', () => {
    const parsed = parseEventInput({ ...valid, title: '  Spaced  ', description: '   ', availableBuyers: undefined });
    assert.equal(parsed?.title, 'Spaced');
    assert.equal(parsed?.description, null);
    assert.equal(parsed?.availableBuyers, null);
  });

  it('rejects a missing or oversized title or venue', () => {
    assert.equal(parseEventInput({ ...valid, title: ' ' }), null);
    assert.equal(parseEventInput({ ...valid, title: 'x'.repeat(256) }), null);
    assert.equal(parseEventInput({ ...valid, venue: '' }), null);
  });

  it('rejects an unknown ticketing tier and an unparseable start time', () => {
    assert.equal(parseEventInput({ ...valid, tier: 'VIP' }), null);
    assert.equal(parseEventInput({ ...valid, startsAt: 'someday' }), null);
  });

  it('requires total seats to be a whole number from 1 to 1,000,000', () => {
    for (const totalSeats of [0, 1.5, -2, 1_000_001, '10']) {
      assert.equal(parseEventInput({ ...valid, totalSeats }), null, String(totalSeats));
    }
  });

  it('keeps available buyers between 1 and the total seats', () => {
    assert.equal(parseEventInput({ ...valid, availableBuyers: 0 }), null);
    assert.equal(parseEventInput({ ...valid, availableBuyers: 101 }), null);
    assert.equal(parseEventInput({ ...valid, availableBuyers: 100 })?.availableBuyers, 100);
  });

  it('prefers price over priceCents, and falls back to priceCents', () => {
    assert.equal(parseEventInput({ ...valid, price: undefined, priceCents: 1234 })?.priceCents, 1234);
    assert.equal(parseEventInput({ ...valid, price: 1, priceCents: 999 })?.priceCents, 100);
  });

  it('rejects an invalid priceCents', () => {
    assert.equal(parseEventInput({ ...valid, price: undefined, priceCents: -1 }), null);
    assert.equal(parseEventInput({ ...valid, price: undefined, priceCents: 1.5 }), null);
  });

  it('rejects a price that is negative, non-numeric, too large or has fractions of a cent', () => {
    for (const price of [-5, 'abc', {}, true, 1_000_001, 10.005]) {
      assert.equal(parseEventInput({ ...valid, price }), null, JSON.stringify(price));
    }
  });

  it('treats an omitted or null price as no price, and still accepts a free event', () => {
    const { price: _price, ...withoutPrice } = valid;
    assert.equal(parseEventInput(withoutPrice)?.priceCents, null);
    assert.equal(parseEventInput({ ...valid, price: null })?.priceCents, null);
    assert.equal(parseEventInput({ ...valid, price: 0 })?.priceCents, 0);
    assert.equal(parseEventInput({ ...valid, price: '0' })?.priceCents, 0);
  });
});

describe('organiser endpoints', () => {
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
    cognitoSend.mock.resetCalls();
    cognitoSend.mock.mockImplementation(async () => ({}));
  });

  async function request(method: string, path: string, options: { token?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = {};
    if (options.token) headers['authorization'] = `Bearer ${options.token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  }

  const ORGANISER_CHECK = /FROM event_team_memberships WHERE event_id = \? AND user_sub = \? AND role = 'ORGANISER'/;
  const isOrganiser = () => on(ORGANISER_CHECK, [{ membership_id: 1 }]);
  const isNotOrganiser = () => on(ORGANISER_CHECK, []);
  const sqlMatching = (pattern: RegExp) => calls.filter((call) => pattern.test(call.sql));
  const ranTransaction = () =>
    calls.map((call) => call.sql).filter((sql) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql));
  const attributes = (sub: string, email: string) => [
    { Name: 'sub', Value: sub },
    { Name: 'email', Value: email },
  ];

  const newEvent = {
    title: 'Event NUS',
    description: 'A night',
    venue: 'NUS ISS',
    startsAt: '2027-09-17T00:23',
    totalSeats: 3,
    availableBuyers: 2,
    tier: 'TIER1_GA',
    price: 25,
  };

  it('reports health without authentication', async () => {
    const response = await request('GET', '/health');
    assert.deepEqual(response, { status: 200, body: { status: 'ok', service: 'event' } });
  });

  it('rejects every organiser endpoint without a valid token', async () => {
    const protectedRoutes: [string, string, unknown?][] = [
      ['GET', '/events/manage'],
      ['POST', '/events', newEvent],
      ['PUT', '/events/5', newEvent],
      ['POST', '/events/5/publish'],
      ['POST', '/events/5/cancel'],
      ['DELETE', '/events/5'],
      ['GET', '/events/5/team-members'],
      ['DELETE', '/events/5/team-members/bob'],
      ['GET', '/team-invitations'],
      ['POST', '/team-invitations/7/accept'],
    ];
    for (const [method, path, body] of protectedRoutes) {
      const anonymous = await request(method, path, body === undefined ? {} : { body });
      const badToken = await request(method, path, { token: 'bad', ...(body === undefined ? {} : { body }) });
      assert.equal(anonymous.status, 401, `${method} ${path} without a token`);
      assert.equal(badToken.status, 401, `${method} ${path} with a bad token`);
    }
    assert.equal(calls.length, 0, 'no database statement may run for an unauthenticated caller');
  });

  describe('GET /events/manage', () => {
    it("lists only the events the caller organises, with the caller's sub as the filter", async () => {
      const rows = [{ event_id: 1, title: 'Event NUS', status: 'PUBLISHED' }];
      on(/FROM events INNER JOIN event_team_memberships/, rows);

      const response = await request('GET', '/events/manage', { token: 'alice' });

      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { events: rows });
      const [query] = calls;
      assert.deepEqual(query?.params, ['alice']);
      assert.match(query?.sql ?? '', /role = 'ORGANISER'/);
      assert.match(query?.sql ?? '', /invite_status = 'ACCEPTED'/);
      assert.match(query?.sql ?? '', /ORDER BY events\.starts_at ASC/);
    });
  });

  describe('POST /events', () => {
    it('rejects an invalid event without touching the database', async () => {
      const response = await request('POST', '/events', { token: 'alice', body: { ...newEvent, title: '' } });
      assert.deepEqual(response, { status: 400, body: { error: 'invalid_event' } });
      assert.equal(calls.length, 0);
    });

    it('refuses an invalid price instead of creating a free event', async () => {
      for (const price of [-5, 'abc']) {
        const response = await request('POST', '/events', { token: 'alice', body: { ...newEvent, price } });
        assert.deepEqual(response, { status: 400, body: { error: 'invalid_event' } }, String(price));
      }
      assert.equal(calls.length, 0, 'nothing may be written for a rejected event');
    });

    it('creates the event, its General Admission stock and the creator as accepted organiser', async () => {
      on(/INSERT INTO events /, { insertId: 100 });
      on(/INSERT INTO inventory_items/, { insertId: 200 });
      on(/INSERT INTO event_team_memberships/, {});

      const response = await request('POST', '/events', { token: 'alice', body: newEvent });

      assert.deepEqual(response, { status: 201, body: { eventId: 100 } });
      assert.deepEqual(ranTransaction(), ['BEGIN', 'COMMIT']);
      assert.deepEqual(sqlMatching(/INSERT INTO events /)[0]?.params, [
        'alice',
        'Event NUS',
        'A night',
        'NUS ISS',
        '2027-09-17T00:23',
        3,
        2,
        'TIER1_GA',
      ]);
      assert.deepEqual(sqlMatching(/INSERT INTO inventory_items/)[0]?.params, [100, 'General Admission', 3, 2500]);
      const membership = sqlMatching(/INSERT INTO event_team_memberships/)[0];
      assert.match(membership?.sql ?? '', /'ORGANISER', 'ACCEPTED'/);
      assert.deepEqual(membership?.params, [100, 'alice', 'alice']);
      assert.equal(sqlMatching(/INSERT INTO seats/).length, 0, 'general admission has no seat map');
    });

    it('provisions one numbered seat per ticket for a reserved-seating event', async () => {
      on(/INSERT INTO events /, { insertId: 100 });
      on(/INSERT INTO inventory_items/, { insertId: 200 });
      on(/INSERT INTO seats/, {});
      on(/INSERT INTO event_team_memberships/, {});

      const response = await request('POST', '/events', {
        token: 'alice',
        body: { ...newEvent, tier: 'TIER2_SEATED' },
      });

      assert.equal(response.status, 201);
      assert.deepEqual(
        sqlMatching(/INSERT INTO seats/).map((call) => call.params),
        [
          [100, 200, 'S001'],
          [100, 200, 'S002'],
          [100, 200, 'S003'],
        ],
      );
    });

    it('rolls the whole creation back and reports 502 when a step fails', async () => {
      mock.method(console, 'error', () => undefined);
      on(/INSERT INTO events /, { insertId: 100 });
      on(/INSERT INTO inventory_items/, new Error('disk full'));

      const response = await request('POST', '/events', { token: 'alice', body: newEvent });

      assert.deepEqual(response, { status: 502, body: { error: 'event_create_failed' } });
      assert.deepEqual(ranTransaction(), ['BEGIN', 'ROLLBACK']);
      mock.restoreAll();
    });
  });

  describe('PUT /events/:eventId', () => {
    it('rejects a malformed event id or body before checking ownership', async () => {
      const badId = await request('PUT', '/events/abc', { token: 'alice', body: newEvent });
      const badBody = await request('PUT', '/events/5', { token: 'alice', body: { ...newEvent, totalSeats: 0 } });
      assert.equal(badId.status, 400);
      assert.equal(badBody.status, 400);
      assert.equal(calls.length, 0);
    });

    it('refuses an invalid price instead of leaving the stored price unchanged', async () => {
      const response = await request('PUT', '/events/5', { token: 'alice', body: { ...newEvent, price: -5 } });
      assert.deepEqual(response, { status: 400, body: { error: 'invalid_event' } });
      assert.equal(calls.length, 0);
    });

    it('refuses someone who is not an accepted organiser of the event', async () => {
      isNotOrganiser();
      const response = await request('PUT', '/events/5', { token: 'mallory', body: newEvent });
      assert.deepEqual(response, { status: 403, body: { error: 'event_organiser_required' } });
      assert.equal(sqlMatching(/UPDATE events/).length, 0);
    });

    it('updates the event and its stock, leaving the price alone when none is given', async () => {
      isOrganiser();
      on(/UPDATE events SET title/, {});
      on(/SELECT inventory_item_id, reserved_qty, sold_qty/, [{ inventory_item_id: 9, reserved_qty: 1, sold_qty: 1 }]);
      on(/UPDATE inventory_items SET total_qty/, {});
      const { price: _price, ...withoutPrice } = newEvent;

      const response = await request('PUT', '/events/5', { token: 'alice', body: withoutPrice });

      assert.equal(response.status, 204);
      assert.deepEqual(ranTransaction(), ['BEGIN', 'COMMIT']);
      assert.deepEqual(sqlMatching(/UPDATE events SET title/)[0]?.params.slice(-1), [5]);
      assert.deepEqual(sqlMatching(/UPDATE inventory_items SET total_qty/)[0]?.params, [3, null, 9]);
    });

    it('will not shrink capacity below what is already reserved or sold', async () => {
      isOrganiser();
      on(/UPDATE events SET title/, {});
      on(/SELECT inventory_item_id, reserved_qty, sold_qty/, [{ inventory_item_id: 9, reserved_qty: 2, sold_qty: 2 }]);

      const response = await request('PUT', '/events/5', { token: 'alice', body: newEvent });

      assert.deepEqual(response, { status: 409, body: { error: 'total_seats_below_allocated' } });
      assert.deepEqual(ranTransaction(), ['BEGIN', 'ROLLBACK']);
      assert.equal(sqlMatching(/UPDATE inventory_items/).length, 0);
    });

    it('creates the General Admission stock when the event has none yet', async () => {
      isOrganiser();
      on(/UPDATE events SET title/, {});
      on(/SELECT inventory_item_id, reserved_qty, sold_qty/, []);
      on(/INSERT INTO inventory_items/, {});

      const response = await request('PUT', '/events/5', { token: 'alice', body: newEvent });

      assert.equal(response.status, 204);
      assert.deepEqual(sqlMatching(/INSERT INTO inventory_items/)[0]?.params, [5, 3, 2500]);
    });

    it('rolls back and reports 502 when the update fails', async () => {
      mock.method(console, 'error', () => undefined);
      isOrganiser();
      on(/UPDATE events SET title/, new Error('deadlock'));

      const response = await request('PUT', '/events/5', { token: 'alice', body: newEvent });

      assert.deepEqual(response, { status: 502, body: { error: 'event_update_failed' } });
      assert.deepEqual(ranTransaction(), ['BEGIN', 'ROLLBACK']);
      mock.restoreAll();
    });
  });

  describe('POST /events/:eventId/publish', () => {
    it('is refused for a non-organiser', async () => {
      isNotOrganiser();
      const response = await request('POST', '/events/5/publish', { token: 'mallory' });
      assert.equal(response.status, 403);
      assert.equal(sqlMatching(/status = 'PUBLISHED'/).length, 0);
    });

    it('makes sure stock exists, then publishes in one transaction', async () => {
      isOrganiser();
      on(/SELECT total_seats, tier FROM events/, [{ total_seats: 3, tier: 'TIER1_GA' }]);
      on(/SELECT inventory_item_id FROM inventory_items/, [{ inventory_item_id: 9 }]);
      on(/UPDATE events SET status = 'PUBLISHED'/, {});

      const response = await request('POST', '/events/5/publish', { token: 'alice' });

      assert.equal(response.status, 204);
      assert.deepEqual(ranTransaction(), ['BEGIN', 'COMMIT']);
      assert.deepEqual(sqlMatching(/status = 'PUBLISHED'/)[0]?.params, [5]);
    });

    it('rolls back and reports 502 when publishing fails', async () => {
      mock.method(console, 'error', () => undefined);
      isOrganiser();
      on(/SELECT total_seats, tier FROM events/, []);
      on(/UPDATE events SET status = 'PUBLISHED'/, new Error('lost connection'));

      const response = await request('POST', '/events/5/publish', { token: 'alice' });

      assert.deepEqual(response, { status: 502, body: { error: 'event_publish_failed' } });
      assert.deepEqual(ranTransaction(), ['BEGIN', 'ROLLBACK']);
      mock.restoreAll();
    });
  });

  describe('POST /events/:eventId/cancel', () => {
    it('is refused for a non-organiser', async () => {
      isNotOrganiser();
      const response = await request('POST', '/events/5/cancel', { token: 'mallory' });
      assert.equal(response.status, 403);
      assert.equal(sqlMatching(/CANCELLED/).length, 0);
    });

    it('cancels the event for an organiser', async () => {
      isOrganiser();
      on(/UPDATE events SET status = 'CANCELLED'/, {});
      const response = await request('POST', '/events/5/cancel', { token: 'alice' });
      assert.equal(response.status, 204);
      assert.deepEqual(sqlMatching(/CANCELLED/)[0]?.params, [5]);
    });
  });

  describe('DELETE /events/:eventId', () => {
    it('is refused for a non-organiser', async () => {
      isNotOrganiser();
      const response = await request('DELETE', '/events/5', { token: 'mallory' });
      assert.equal(response.status, 403);
      assert.equal(sqlMatching(/DELETE FROM events/).length, 0);
    });

    it('deletes a draft event', async () => {
      isOrganiser();
      on(/DELETE FROM events/, { affectedRows: 1 });
      const response = await request('DELETE', '/events/5', { token: 'alice' });
      assert.equal(response.status, 204);
      assert.match(sqlMatching(/DELETE FROM events/)[0]?.sql ?? '', /status = 'DRAFT'/);
    });

    it('will not delete an event that is no longer a draft', async () => {
      isOrganiser();
      on(/DELETE FROM events/, { affectedRows: 0 });
      const response = await request('DELETE', '/events/5', { token: 'alice' });
      assert.deepEqual(response, { status: 409, body: { error: 'only_draft_events_can_be_deleted' } });
    });
  });

  describe('team members', () => {
    it('lists the team to an organiser and rejects a bad event id or a non-organiser', async () => {
      const members = [{ membership_id: 1, user_sub: 'bob', role: 'HELPER' }];
      isOrganiser();
      on(/FROM event_team_memberships WHERE event_id = \? ORDER BY role/, members);
      assert.deepEqual(await request('GET', '/events/5/team-members', { token: 'alice' }), {
        status: 200,
        body: { members },
      });

      assert.equal((await request('GET', '/events/zero/team-members', { token: 'alice' })).status, 400);

      rules = [];
      isNotOrganiser();
      assert.equal((await request('GET', '/events/5/team-members', { token: 'mallory' })).status, 403);
    });

    describe('DELETE /events/:eventId/team-members/:userSub', () => {
      const scriptTeam = (owner: string, memberRole: string | null) => {
        on(/SELECT organiser_sub FROM events/, [{ organiser_sub: owner }]);
        on(/SELECT role FROM event_team_memberships/, memberRole ? [{ role: memberRole }] : []);
        on(/DELETE FROM event_team_memberships/, {});
      };
      const removed = () => sqlMatching(/DELETE FROM event_team_memberships/).length === 1;

      it('will not let an organiser remove themselves', async () => {
        const response = await request('DELETE', '/events/5/team-members/alice', { token: 'alice' });
        assert.deepEqual(response, { status: 400, body: { error: 'invalid_team_member_removal' } });
        assert.equal(calls.length, 0);
      });

      it('reports an unknown event or member', async () => {
        on(/SELECT organiser_sub FROM events/, []);
        assert.equal((await request('DELETE', '/events/5/team-members/bob', { token: 'alice' })).status, 404);

        rules = [];
        scriptTeam('alice', null);
        assert.deepEqual(await request('DELETE', '/events/5/team-members/bob', { token: 'alice' }), {
          status: 404,
          body: { error: 'team_member_not_found' },
        });
      });

      it('lets only the event owner remove another organiser', async () => {
        scriptTeam('owner', 'ORGANISER');
        const refused = await request('DELETE', '/events/5/team-members/carol', { token: 'alice' });
        assert.deepEqual(refused, { status: 403, body: { error: 'event_owner_required' } });
        assert.equal(removed(), false);

        calls.length = 0;
        rules = [];
        scriptTeam('owner', 'ORGANISER');
        const allowed = await request('DELETE', '/events/5/team-members/carol', { token: 'owner' });
        assert.equal(allowed.status, 204);
        assert.deepEqual(sqlMatching(/DELETE FROM event_team_memberships/)[0]?.params, [5, 'carol']);
      });

      it('lets an accepted organiser remove a helper, but nobody else', async () => {
        scriptTeam('owner', 'HELPER');
        isOrganiser();
        assert.equal((await request('DELETE', '/events/5/team-members/bob', { token: 'alice' })).status, 204);

        calls.length = 0;
        rules = [];
        scriptTeam('owner', 'HELPER');
        isNotOrganiser();
        const refused = await request('DELETE', '/events/5/team-members/bob', { token: 'mallory' });
        assert.deepEqual(refused, { status: 403, body: { error: 'event_organiser_required' } });
        assert.equal(removed(), false);
      });
    });
  });

  describe('POST /events/:eventId/invitations', () => {
    const scriptInvite = () => {
      isOrganiser();
      on(/SELECT organiser_sub FROM events/, [{ organiser_sub: 'owner' }]);
      on(/INSERT INTO event_team_memberships/, {});
    };
    const invite = (body: unknown, token = 'alice') =>
      request('POST', '/events/5/invitations', { token, body });

    it('rejects an invitation with no role, no target or a bad event id', async () => {
      assert.equal((await invite({ email: 'b@x.com' })).status, 400);
      assert.equal((await invite({ role: 'HELPER' })).status, 400);
      const badId = await request('POST', '/events/x/invitations', {
        token: 'alice',
        body: { email: 'b@x.com', role: 'HELPER' },
      });
      assert.equal(badId.status, 400);
      assert.equal(cognitoSend.mock.callCount(), 0);
    });

    it('is refused for a non-organiser', async () => {
      isNotOrganiser();
      const response = await invite({ email: 'b@x.com', role: 'HELPER' }, 'mallory');
      assert.equal(response.status, 403);
      assert.equal(cognitoSend.mock.callCount(), 0);
    });

    it('invites a user found by email as a pending member, granted by the event owner', async () => {
      scriptInvite();
      cognitoSend.mock.mockImplementation(async () => ({
        Users: [{ Attributes: attributes('sub-bob', 'bob@example.com') }],
      }));

      const response = await invite({ email: '  Bob@Example.com ', role: 'HELPER' });

      assert.deepEqual(response, { status: 201, body: { invited: true } });
      const command = cognitoSend.mock.calls[0]?.arguments[0] as ListUsersCommand;
      assert.ok(command instanceof ListUsersCommand);
      assert.equal(command.input['Filter'], 'email = "bob@example.com"');
      const insert = sqlMatching(/INSERT INTO event_team_memberships/)[0];
      assert.match(insert?.sql ?? '', /'PENDING'/);
      assert.deepEqual(insert?.params, [5, 'sub-bob', 'bob@example.com', 'HELPER', 'owner']);
    });

    it('escapes quotes so an email cannot break out of the Cognito filter', async () => {
      scriptInvite();
      cognitoSend.mock.mockImplementation(async () => ({ Users: [] }));

      await invite({ email: 'a"b@x.com', role: 'HELPER' });

      const command = cognitoSend.mock.calls[0]?.arguments[0] as ListUsersCommand;
      assert.equal(command.input['Filter'], 'email = "a\\"b@x.com"');
    });

    it('invites a user found by username', async () => {
      scriptInvite();
      cognitoSend.mock.mockImplementation(async () => ({
        UserAttributes: attributes('sub-carol', 'carol@example.com'),
      }));

      const response = await invite({ username: 'carol', role: 'ORGANISER' });

      assert.equal(response.status, 201);
      const command = cognitoSend.mock.calls[0]?.arguments[0] as AdminGetUserCommand;
      assert.ok(command instanceof AdminGetUserCommand);
      assert.equal(command.input['Username'], 'carol');
      assert.deepEqual(sqlMatching(/INSERT INTO event_team_memberships/)[0]?.params, [
        5,
        'sub-carol',
        'carol@example.com',
        'ORGANISER',
        'owner',
      ]);
    });

    it('reports an unknown event, an unknown user, and a user with no usable identity', async () => {
      isOrganiser();
      on(/SELECT organiser_sub FROM events/, []);
      assert.equal((await invite({ email: 'b@x.com', role: 'HELPER' })).status, 404);

      rules = [];
      scriptInvite();
      cognitoSend.mock.mockImplementation(async () => ({ Users: [] }));
      assert.deepEqual(await invite({ email: 'b@x.com', role: 'HELPER' }), {
        status: 404,
        body: { error: 'invited_user_not_found' },
      });

      cognitoSend.mock.mockImplementation(async () => ({
        Users: [{ Attributes: [{ Name: 'email', Value: 'b@x.com' }] }],
      }));
      assert.deepEqual(await invite({ email: 'b@x.com', role: 'HELPER' }), {
        status: 400,
        body: { error: 'invited_user_missing_identity' },
      });
      assert.equal(sqlMatching(/INSERT INTO event_team_memberships/).length, 0);
    });

    it('reports 409 when the user is already invited or a member', async () => {
      isOrganiser();
      on(/SELECT organiser_sub FROM events/, [{ organiser_sub: 'owner' }]);
      on(
        /INSERT INTO event_team_memberships/,
        Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' }),
      );
      cognitoSend.mock.mockImplementation(async () => ({
        Users: [{ Attributes: attributes('sub-bob', 'bob@example.com') }],
      }));

      const response = await invite({ email: 'bob@example.com', role: 'HELPER' });

      assert.deepEqual(response, { status: 409, body: { error: 'already_invited_or_member' } });
    });

    it('reports 502 when Cognito is unavailable', async () => {
      mock.method(console, 'error', () => undefined);
      scriptInvite();
      cognitoSend.mock.mockImplementation(async () => {
        throw new Error('network down');
      });

      const response = await invite({ email: 'b@x.com', role: 'HELPER' });

      assert.deepEqual(response, { status: 502, body: { error: 'invitation_failed' } });
      mock.restoreAll();
    });
  });

  describe('GET /events/:eventId/users', () => {
    const user = (name: string, email: string) => ({
      Username: name.toLowerCase(),
      Attributes: [{ Name: 'name', Value: name }, ...attributes(`sub-${name}`, email)],
    });

    it('needs at least two characters to search', async () => {
      isOrganiser();
      const response = await request('GET', '/events/5/users?search=b', { token: 'alice' });
      assert.deepEqual(response, { status: 400, body: { error: 'search_requires_two_characters' } });
      assert.equal(cognitoSend.mock.callCount(), 0);
    });

    it('returns matching users by name or email, with names split into first and last', async () => {
      isOrganiser();
      cognitoSend.mock.mockImplementation(async () => ({
        Users: [user('Bob Tan', 'bob@example.com'), user('Alice Lim', 'alice@example.com')],
      }));

      const response = await request('GET', '/events/5/users?search=BOB', { token: 'alice' });

      assert.deepEqual(response, {
        status: 200,
        body: { users: [{ username: 'bob tan', firstName: 'Bob', lastName: 'Tan', email: 'bob@example.com' }] },
      });
    });

    it('is refused for a non-organiser', async () => {
      isNotOrganiser();
      const response = await request('GET', '/events/5/users?search=bob', { token: 'mallory' });
      assert.equal(response.status, 403);
      assert.equal(cognitoSend.mock.callCount(), 0);
    });
  });

  describe('team invitations', () => {
    it("lists the caller's pending invitations", async () => {
      const invitations = [{ membership_id: 7, event_id: 5, role: 'HELPER', title: 'Event NUS' }];
      on(/FROM event_team_memberships INNER JOIN events/, invitations);

      const response = await request('GET', '/team-invitations', { token: 'bob' });

      assert.deepEqual(response, { status: 200, body: { invitations } });
      assert.deepEqual(calls[0]?.params, ['bob']);
      assert.match(calls[0]?.sql ?? '', /invite_status = 'PENDING'/);
    });

    it('accepts or rejects an invitation, only for its own invitee', async () => {
      on(/UPDATE event_team_memberships SET invite_status/, { affectedRows: 1 });

      assert.equal((await request('POST', '/team-invitations/7/accept', { token: 'bob' })).status, 204);
      assert.deepEqual(calls.at(-1)?.params, ['ACCEPTED', 7, 'bob']);

      assert.equal((await request('POST', '/team-invitations/7/reject', { token: 'bob' })).status, 204);
      assert.deepEqual(calls.at(-1)?.params, ['REJECTED', 7, 'bob']);
      assert.match(calls.at(-1)?.sql ?? '', /invite_status = 'PENDING'/);
    });

    it('reports 404 when there is no pending invitation for the caller', async () => {
      on(/UPDATE event_team_memberships SET invite_status/, { affectedRows: 0 });
      const response = await request('POST', '/team-invitations/7/accept', { token: 'mallory' });
      assert.deepEqual(response, { status: 404, body: { error: 'invitation_not_found' } });
    });

    it('rejects a malformed invitation id or an unknown decision', async () => {
      assert.equal((await request('POST', '/team-invitations/abc/accept', { token: 'bob' })).status, 400);
      assert.equal((await request('POST', '/team-invitations/0/accept', { token: 'bob' })).status, 400);
      assert.equal((await request('POST', '/team-invitations/7/maybe', { token: 'bob' })).status, 400);
      assert.equal(calls.length, 0);
    });
  });
});
