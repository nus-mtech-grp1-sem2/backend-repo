import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

import { installOfflineServices, startServer, type TestServer } from '../../test-support/offline-services.js';

// Nothing here can reach a real database or AWS: see test-support/offline-services.ts.
const db = installOfflineServices(mock, {
  env: { DB_NAME: 'event_inventory' },
  claims: (token) => ({ sub: token }),
});
const { calls, on } = db;

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

const { app, DATABASE_TIMEZONE, parseEventInput, parsePriceCents, parseStartsAt, validEventId } = await import('./index.js');

describe('database timezone', () => {
  it('reads DATETIME columns as UTC whatever zone the host runs in', () => {
    assert.equal(DATABASE_TIMEZONE, 'Z');
  });
});

describe('parseStartsAt', () => {
  it('reads a datetime-local value with no zone as Singapore time and stores it in UTC', () => {
    assert.equal(parseStartsAt('2026-10-12T23:13'), '2026-10-12 15:13:00');
    assert.equal(parseStartsAt('2027-09-17T00:23'), '2027-09-16 16:23:00');
    assert.equal(parseStartsAt(' 2027-09-17 00:23:45 '), '2027-09-16 16:23:45');
  });

  it('keeps the zone of a time sent with Z or an offset', () => {
    assert.equal(parseStartsAt('2026-10-12T15:13:00.000Z'), '2026-10-12 15:13:00');
    assert.equal(parseStartsAt('2026-10-12T23:13:00+08:00'), '2026-10-12 15:13:00');
    assert.equal(parseStartsAt('2026-10-12T10:13-05:00'), '2026-10-12 15:13:00');
  });

  it('refuses text, a date with no time, and a day the month does not have', () => {
    for (const value of ['someday', '', '2027-09-17', '2027-02-30T10:00', '2027-13-01T10:00', '2027-09-17T10:00 PM', 1_790_000_000_000, undefined]) {
      assert.equal(parseStartsAt(value), null, String(value));
    }
    assert.equal(parseStartsAt('2028-02-29T10:00'), '2028-02-29 02:00:00', 'a leap day is a real day');
  });
});

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

  it('accepts a complete event, converts the price to cents and the start time to UTC', () => {
    assert.deepEqual(parseEventInput(valid), {
      title: 'Event NUS',
      description: 'A night',
      venue: 'NUS ISS',
      startsAt: '2027-09-16 16:23:00',
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

  it('ignores total seats, which only Configure inventory sets', () => {
    for (const totalSeats of [undefined, 0, -2, 'lots']) {
      assert.deepEqual(parseEventInput({ ...valid, totalSeats }), parseEventInput(valid), String(totalSeats));
    }
    assert.equal('totalSeats' in parseEventInput(valid)!, false);
  });

  it('keeps available buyers a whole number from 1 to 1,000,000', () => {
    assert.equal(parseEventInput({ ...valid, availableBuyers: 0 }), null);
    assert.equal(parseEventInput({ ...valid, availableBuyers: 1.5 }), null);
    assert.equal(parseEventInput({ ...valid, availableBuyers: 1_000_001 }), null);
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
  let server: TestServer;
  let base = '';

  before(async () => {
    server = await startServer(app);
    base = server.base;
  });
  after(() => server.close());
  beforeEach(() => {
    db.reset();
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
      ['PUT', '/events/5/available-buyers', { availableBuyers: 2 }],
      ['POST', '/events/5/publish'],
      ['POST', '/events/5/cancel'],
      ['GET', '/events/5/cancellation-impact'],
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

  describe('GET /events/:eventId', () => {
    const EVENT_DETAIL = /FROM events LEFT JOIN \( SELECT event_id, MIN\(price_cents\)/;

    it('prices the event from its cheapest zone and counts seats across every zone, whatever the zones are called', async () => {
      const row = { event_id: 5, title: 'New Year Party 2027', price_cents: 100, remaining_qty: 400 };
      on(EVENT_DETAIL, [row]);

      const response = await request('GET', '/events/5');

      assert.deepEqual(response, { status: 200, body: { event: row } });
      const [query] = calls;
      assert.deepEqual(query?.params, [5, 5]);
      assert.match(query?.sql ?? '', /SUM\(total_qty - reserved_qty - sold_qty\) AS remaining_qty FROM inventory_items WHERE event_id = \? GROUP BY event_id/);
      assert.doesNotMatch(query?.sql ?? '', /General Admission/);
    });

    it('reports 404 for an event that does not exist', async () => {
      on(EVENT_DETAIL, []);

      const response = await request('GET', '/events/5');

      assert.deepEqual(response, { status: 404, body: { error: 'event_not_found' } });
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

    for (const tier of ['TIER1_GA', 'TIER2_SEATED']) {
      it(`creates a ${tier} event with no seats and no zones, and the creator as accepted organiser`, async () => {
        on(/INSERT INTO events /, { insertId: 100 });
        on(/INSERT INTO event_team_memberships/, {});

        const response = await request('POST', '/events', { token: 'alice', body: { ...newEvent, tier, totalSeats: 50 } });

        assert.deepEqual(response, { status: 201, body: { eventId: 100 } });
        assert.deepEqual(ranTransaction(), ['BEGIN', 'COMMIT']);
        const [insert] = sqlMatching(/INSERT INTO events /);
        assert.match(insert!.sql, /VALUES \(\?, \?, \?, \?, \?, 0, NULL, \?\)/, 'no seats and no buyer limit until inventory exists');
        assert.deepEqual(insert!.params, ['alice', 'Event NUS', 'A night', 'NUS ISS', '2027-09-16 16:23:00', tier], 'starts_at is stored in UTC');
        assert.equal(sqlMatching(/inventory_items|INSERT INTO seats/).length, 0, 'zones and seats come from Configure inventory');
        const membership = sqlMatching(/INSERT INTO event_team_memberships/)[0];
        assert.match(membership?.sql ?? '', /'ORGANISER', 'ACCEPTED'/);
        assert.deepEqual(membership?.params, [100, 'alice', '', 'alice']);
      });
    }

    it("stores the owner's email from Cognito on their membership", async () => {
      cognitoSend.mock.mockImplementation(async () => ({
        UserAttributes: [{ Name: 'email', Value: 'alice@example.com' }],
      }));
      on(/INSERT INTO events /, { insertId: 100 });
      on(/INSERT INTO event_team_memberships/, {});

      const response = await request('POST', '/events', { token: 'alice', body: newEvent });

      assert.equal(response.status, 201);
      const command = cognitoSend.mock.calls[0]?.arguments[0] as AdminGetUserCommand;
      assert.ok(command instanceof AdminGetUserCommand);
      assert.equal(command.input['Username'], 'alice');
      const membership = sqlMatching(/INSERT INTO event_team_memberships/)[0];
      assert.deepEqual(membership?.params, [100, 'alice', 'alice@example.com', 'alice']);
    });

    it('still creates the event when the Cognito lookup fails', async () => {
      mock.method(console, 'error', () => undefined);
      cognitoSend.mock.mockImplementation(async () => {
        throw new Error('throttled');
      });
      on(/INSERT INTO events /, { insertId: 100 });
      on(/INSERT INTO event_team_memberships/, {});

      const response = await request('POST', '/events', { token: 'alice', body: newEvent });

      assert.deepEqual(response, { status: 201, body: { eventId: 100 } });
      assert.deepEqual(sqlMatching(/INSERT INTO event_team_memberships/)[0]?.params, [100, 'alice', '', 'alice']);
      mock.restoreAll();
    });

    it('rolls the whole creation back and reports 502 when a step fails', async () => {
      mock.method(console, 'error', () => undefined);
      on(/INSERT INTO events /, { insertId: 100 });
      on(/INSERT INTO event_team_memberships/, new Error('disk full'));

      const response = await request('POST', '/events', { token: 'alice', body: newEvent });

      assert.deepEqual(response, { status: 502, body: { error: 'event_create_failed' } });
      assert.deepEqual(ranTransaction(), ['BEGIN', 'ROLLBACK']);
      mock.restoreAll();
    });
  });

  describe('PUT /events/:eventId', () => {
    it('rejects a malformed event id or body before checking ownership', async () => {
      const badId = await request('PUT', '/events/abc', { token: 'alice', body: newEvent });
      const badBody = await request('PUT', '/events/5', { token: 'alice', body: { ...newEvent, title: ' ' } });
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

    const stored = (status: string, totalSeats = 10) =>
      on(/SELECT status, total_seats FROM events/, [{ status, total_seats: totalSeats }]);

    it("updates a draft's details but never its capacity, zones or price, which the inventory owns", async () => {
      isOrganiser();
      stored('DRAFT');
      on(/UPDATE events SET title/, {});

      const response = await request('PUT', '/events/5', { token: 'alice', body: { ...newEvent, totalSeats: 999 } });

      assert.equal(response.status, 204);
      assert.deepEqual(ranTransaction(), ['BEGIN', 'COMMIT']);
      const [update] = sqlMatching(/UPDATE events SET title/);
      assert.doesNotMatch(update!.sql, /total_seats/);
      assert.deepEqual(update!.params, ['Event NUS', 'A night', 'NUS ISS', '2027-09-16 16:23:00', 2, 'TIER1_GA', 5], 'starts_at is stored in UTC');
      assert.equal(sqlMatching(/inventory_items/).length, 0);
    });

    it('will not allow more available buyers than the stored total seats', async () => {
      isOrganiser();
      stored('DRAFT', 3);

      const response = await request('PUT', '/events/5', { token: 'alice', body: { ...newEvent, totalSeats: 50, availableBuyers: 4 } });

      assert.deepEqual(response, { status: 409, body: { error: 'available_buyers_above_total_seats' } });
      assert.deepEqual(ranTransaction(), ['BEGIN', 'ROLLBACK']);
      assert.equal(sqlMatching(/UPDATE events/).length, 0);
    });

    for (const status of ['PUBLISHED', 'CANCELLED']) {
      it(`will not edit a ${status.toLowerCase()} event, not even its total seats`, async () => {
        isOrganiser();
        stored(status);

        const response = await request('PUT', '/events/5', { token: 'alice', body: { ...newEvent, totalSeats: 40 } });

        assert.deepEqual(response, { status: 409, body: { error: 'event_not_editable' } });
        assert.deepEqual(ranTransaction(), ['BEGIN', 'ROLLBACK']);
        assert.equal(sqlMatching(/^UPDATE/).length, 0);
      });
    }

    it('rolls back and reports 502 when the update fails', async () => {
      mock.method(console, 'error', () => undefined);
      isOrganiser();
      stored('DRAFT');
      on(/UPDATE events SET title/, new Error('deadlock'));

      const response = await request('PUT', '/events/5', { token: 'alice', body: newEvent });

      assert.deepEqual(response, { status: 502, body: { error: 'event_update_failed' } });
      assert.deepEqual(ranTransaction(), ['BEGIN', 'ROLLBACK']);
      mock.restoreAll();
    });
  });

  describe('PUT /events/:eventId/available-buyers', () => {
    const stored = (status: string, totalSeats = 10, hasStarted = 0) =>
      on(/SELECT status, total_seats, starts_at < UTC_TIMESTAMP/, [{
        status,
        total_seats: totalSeats,
        has_started: hasStarted,
      }]);

    it('updates only waiting-room concurrency for a published event', async () => {
      isOrganiser();
      stored('PUBLISHED');
      on(/UPDATE events SET available_buyers/, {});

      const response = await request('PUT', '/events/5/available-buyers', {
        token: 'alice',
        body: { availableBuyers: 4 },
      });

      assert.equal(response.status, 204);
      assert.deepEqual(ranTransaction(), ['BEGIN', 'COMMIT']);
      assert.deepEqual(sqlMatching(/UPDATE events SET available_buyers/)[0]?.params, [4, 5]);
      assert.equal(sqlMatching(/UPDATE events SET title/).length, 0);
    });

    it('allows only an accepted event organiser', async () => {
      isNotOrganiser();

      const response = await request('PUT', '/events/5/available-buyers', {
        token: 'mallory',
        body: { availableBuyers: 4 },
      });

      assert.deepEqual(response, { status: 403, body: { error: 'event_organiser_required' } });
      assert.equal(sqlMatching(/UPDATE events/).length, 0);
    });

    it('accepts blank as the automatic 10% setting', async () => {
      isOrganiser();
      stored('DRAFT');
      on(/UPDATE events SET available_buyers/, {});

      const response = await request('PUT', '/events/5/available-buyers', {
        token: 'alice',
        body: { availableBuyers: null },
      });

      assert.equal(response.status, 204);
      assert.deepEqual(sqlMatching(/UPDATE events SET available_buyers/)[0]?.params, [null, 5]);
    });

    it('rejects invalid or excessive values', async () => {
      const invalid = await request('PUT', '/events/5/available-buyers', {
        token: 'alice',
        body: { availableBuyers: 0 },
      });
      assert.deepEqual(invalid, { status: 400, body: { error: 'invalid_available_buyers' } });

      db.reset();
      isOrganiser();
      stored('PUBLISHED', 3);
      const excessive = await request('PUT', '/events/5/available-buyers', {
        token: 'alice',
        body: { availableBuyers: 4 },
      });
      assert.deepEqual(excessive, {
        status: 409,
        body: { error: 'available_buyers_above_total_seats' },
      });
      assert.equal(sqlMatching(/UPDATE events/).length, 0);
    });

    it('keeps cancelled and completed events locked', async () => {
      for (const [status, hasStarted] of [['CANCELLED', 0], ['PUBLISHED', 1]] as const) {
        db.reset();
        isOrganiser();
        stored(status, 10, hasStarted);
        const response = await request('PUT', '/events/5/available-buyers', {
          token: 'alice',
          body: { availableBuyers: 2 },
        });
        assert.deepEqual(response, { status: 409, body: { error: 'event_not_editable' } });
        assert.equal(sqlMatching(/UPDATE events/).length, 0);
      }
    });
  });

  describe('POST /events/:eventId/publish', () => {
    it('is refused for a non-organiser', async () => {
      isNotOrganiser();
      const response = await request('POST', '/events/5/publish', { token: 'mallory' });
      assert.equal(response.status, 403);
      assert.equal(sqlMatching(/status = 'PUBLISHED'/).length, 0);
    });

    it('publishes an event whose inventory is configured, in one transaction', async () => {
      isOrganiser();
      on(/SELECT e.total_seats, \(SELECT COUNT\(\*\) FROM inventory_items/, [{ total_seats: 3, zones: 1 }]);
      on(/UPDATE events SET status = 'PUBLISHED'/, {});

      const response = await request('POST', '/events/5/publish', { token: 'alice' });

      assert.equal(response.status, 204);
      assert.deepEqual(ranTransaction(), ['BEGIN', 'COMMIT']);
      assert.deepEqual(sqlMatching(/status = 'PUBLISHED'/)[0]?.params, [5]);
      assert.equal(sqlMatching(/INSERT/).length, 0, 'publishing never creates stock');
    });

    it('will not publish until Configure inventory has created a zone', async () => {
      for (const row of [{ total_seats: 0, zones: 0 }, { total_seats: 0, zones: 1 }]) {
        db.reset();
        isOrganiser();
        on(/SELECT e.total_seats, \(SELECT COUNT\(\*\) FROM inventory_items/, [row]);

        const response = await request('POST', '/events/5/publish', { token: 'alice' });

        assert.deepEqual(response, { status: 409, body: { error: 'inventory_not_configured' } });
        assert.deepEqual(ranTransaction(), ['BEGIN', 'ROLLBACK']);
        assert.equal(sqlMatching(/^(UPDATE|INSERT)/).length, 0);
      }
    });

    it('rolls back and reports 502 when publishing fails', async () => {
      mock.method(console, 'error', () => undefined);
      isOrganiser();
      on(/SELECT e.total_seats, \(SELECT COUNT\(\*\) FROM inventory_items/, [{ total_seats: 3, zones: 1 }]);
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

    const IMPACT = /FROM checkout\.orders o JOIN checkout\.order_items oi/;
    const sold = (customers: number, ticketsSold: number) =>
      on(IMPACT, [{ customers, tickets_sold: ticketsSold }]);
    const scriptCancel = () => {
      on(/SELECT event_id FROM events WHERE event_id = \? FOR UPDATE/, [{ event_id: 5 }]);
      on(/UPDATE events SET status = 'CANCELLED'/, {});
      on(/UPDATE ticketing\.tickets SET status = 'VOID'/, {});
      on(/UPDATE checkout\.orders SET status = 'CANCELLED'/, {});
    };

    it('cancels an event nobody has bought tickets to, without asking for confirmation', async () => {
      isOrganiser();
      sold(0, 0);
      scriptCancel();
      const response = await request('POST', '/events/5/cancel', { token: 'alice' });
      assert.equal(response.status, 204);
      assert.deepEqual(ranTransaction(), ['BEGIN', 'COMMIT']);
      assert.deepEqual(sqlMatching(/UPDATE events SET status = 'CANCELLED'/)[0]?.params, [5]);
    });

    it('asks for confirmation once customers have bought tickets, and changes nothing', async () => {
      for (const body of [undefined, {}, { confirm: 'yes' }, { confirm: 1 }]) {
        db.reset();
        isOrganiser();
        sold(2, 3);
        scriptCancel();
        const response = await request('POST', '/events/5/cancel', { token: 'alice', body });
        assert.deepEqual(
          response,
          { status: 409, body: { error: 'cancellation_confirmation_required', customers: 2, ticketsSold: 3 } },
          JSON.stringify(body),
        );
        assert.deepEqual(ranTransaction(), ['BEGIN', 'ROLLBACK']);
        assert.equal(sqlMatching(/^UPDATE/).length, 0);
      }
    });

    it('once confirmed, cancels the event and voids every ticket sold for it in one transaction', async () => {
      isOrganiser();
      sold(2, 3);
      scriptCancel();
      const response = await request('POST', '/events/5/cancel', { token: 'alice', body: { confirm: true } });
      assert.equal(response.status, 204);
      assert.deepEqual(ranTransaction(), ['BEGIN', 'COMMIT']);
      const voided = sqlMatching(/UPDATE ticketing\.tickets SET status = 'VOID'/);
      assert.equal(voided.length, 1);
      assert.match(voided[0]!.sql, /WHERE event_id = \? AND status <> 'VOID'/);
      assert.deepEqual(voided[0]!.params, [5]);
    });

    it('marks the paid orders refunded, so cancelling again later only counts newer buyers', async () => {
      isOrganiser();
      sold(2, 3);
      scriptCancel();
      await request('POST', '/events/5/cancel', { token: 'alice', body: { confirm: true } });
      const refunded = sqlMatching(/UPDATE checkout\.orders SET status = 'CANCELLED'/);
      assert.equal(refunded.length, 1);
      assert.match(refunded[0]!.sql, /WHERE event_id = \? AND status = 'PAID'/);
      assert.deepEqual(refunded[0]!.params, [5]);
      assert.match(sqlMatching(IMPACT)[0]!.sql, /o\.status = 'PAID'/, 'only orders still paid are counted');
    });

    it('rolls back and reports 502 when voiding the tickets fails, leaving the event live', async () => {
      mock.method(console, 'error', () => undefined);
      isOrganiser();
      sold(1, 1);
      on(/SELECT event_id FROM events WHERE event_id = \? FOR UPDATE/, [{ event_id: 5 }]);
      on(/UPDATE events SET status = 'CANCELLED'/, {});
      on(/UPDATE ticketing\.tickets SET status = 'VOID'/, new Error('lock wait timeout'));
      const response = await request('POST', '/events/5/cancel', { token: 'alice', body: { confirm: true } });
      assert.deepEqual(response, { status: 502, body: { error: 'event_cancel_failed' } });
      assert.deepEqual(ranTransaction(), ['BEGIN', 'ROLLBACK']);
      mock.restoreAll();
    });
  });

  describe('GET /events/:eventId/cancellation-impact', () => {
    const IMPACT = /FROM checkout\.orders o JOIN checkout\.order_items oi/;

    it('is refused for a non-organiser', async () => {
      isNotOrganiser();
      const response = await request('GET', '/events/5/cancellation-impact', { token: 'mallory' });
      assert.equal(response.status, 403);
      assert.equal(sqlMatching(IMPACT).length, 0);
    });

    it('reports how many customers and tickets a cancellation would affect', async () => {
      isOrganiser();
      on(IMPACT, [{ customers: 2, tickets_sold: '3' }]);
      const response = await request('GET', '/events/5/cancellation-impact', { token: 'alice' });
      assert.deepEqual(response, {
        status: 200,
        body: { eventId: 5, customers: 2, ticketsSold: 3, requiresConfirmation: true },
      });
      assert.match(sqlMatching(IMPACT)[0]!.sql, /o\.status = 'PAID'/);
    });

    it('needs no confirmation when nobody has bought tickets', async () => {
      isOrganiser();
      on(IMPACT, [{ customers: 0, tickets_sold: 0 }]);
      const response = await request('GET', '/events/5/cancellation-impact', { token: 'alice' });
      assert.equal(response.body?.requiresConfirmation, false);
    });
  });

  describe('DELETE /events/:eventId', () => {
    it('is refused for a non-organiser', async () => {
      isNotOrganiser();
      const response = await request('DELETE', '/events/5', { token: 'mallory' });
      assert.equal(response.status, 403);
      assert.equal(sqlMatching(/DELETE FROM events/).length, 0);
    });

    it('deletes a draft together with its zones, seats, map and team, children first', async () => {
      isOrganiser();
      on(/SELECT status FROM events/, [{ status: 'DRAFT' }]);
      on(/FROM inventory_holds/, []);
      on(/^DELETE FROM/, { affectedRows: 1 });

      const response = await request('DELETE', '/events/5', { token: 'alice' });

      assert.equal(response.status, 204);
      assert.deepEqual(ranTransaction(), ['BEGIN', 'COMMIT']);
      assert.deepEqual(
        sqlMatching(/^DELETE FROM/).map((call) => call.sql.split(' ')[2]),
        ['seats', 'inventory_items', 'event_grid_settings', 'event_team_memberships', 'events'],
      );
      assert.ok(sqlMatching(/^DELETE FROM/).every((call) => call.params[0] === 5));
    });

    for (const status of ['PUBLISHED', 'CANCELLED']) {
      it(`will not delete a ${status.toLowerCase()} event`, async () => {
        isOrganiser();
        on(/SELECT status FROM events/, [{ status }]);
        const response = await request('DELETE', '/events/5', { token: 'alice' });
        assert.deepEqual(response, { status: 409, body: { error: 'only_draft_events_can_be_deleted' } });
        assert.deepEqual(ranTransaction(), ['BEGIN', 'ROLLBACK']);
        assert.equal(sqlMatching(/^DELETE/).length, 0);
      });
    }

    it('keeps a draft that has reservation history', async () => {
      isOrganiser();
      on(/SELECT status FROM events/, [{ status: 'DRAFT' }]);
      on(/FROM inventory_holds/, [{ 1: 1 }]);
      const response = await request('DELETE', '/events/5', { token: 'alice' });
      assert.deepEqual(response, { status: 409, body: { error: 'event_has_reservation_history' } });
      assert.equal(sqlMatching(/^DELETE/).length, 0);
    });

    it('rolls back and reports 502 instead of crashing when a delete fails', async () => {
      mock.method(console, 'error', () => undefined);
      isOrganiser();
      on(/SELECT status FROM events/, [{ status: 'DRAFT' }]);
      on(/FROM inventory_holds/, []);
      on(/^DELETE FROM seats/, {});
      on(/^DELETE FROM/, new Error('foreign key'));
      const response = await request('DELETE', '/events/5', { token: 'alice' });
      assert.deepEqual(response, { status: 502, body: { error: 'event_delete_failed' } });
      assert.deepEqual(ranTransaction(), ['BEGIN', 'ROLLBACK']);
      mock.restoreAll();
    });
  });

  describe('team members', () => {
    // Revoked members are kept as a record of past access, but are not on the team.
    const ROSTER = /FROM event_team_memberships WHERE event_id = \? AND invite_status <> 'REVOKED' ORDER BY role/;

    it("fills in an owner's missing email from Cognito, keeping stored emails", async () => {
      isOrganiser();
      on(ROSTER, [
        { membership_id: 1, user_sub: 'alice', user_email: '', role: 'ORGANISER' },
        { membership_id: 2, user_sub: 'bob', user_email: 'bob@example.com', role: 'HELPER' },
      ]);
      cognitoSend.mock.mockImplementation(async (command) => {
        const username = (command as AdminGetUserCommand).input['Username'];
        return {
          UserAttributes: [
            { Name: 'name', Value: username === 'alice' ? 'Alice Owner' : 'Bob Helper' },
            { Name: 'email', Value: `${String(username)}@cognito.example` },
          ],
        };
      });

      const response = await request('GET', '/events/5/team-members', { token: 'alice' });

      assert.equal(response.status, 200);
      assert.deepEqual(response.body, {
        members: [
          { membership_id: 1, user_sub: 'alice', user_email: 'alice@cognito.example', role: 'ORGANISER', name: 'Alice Owner' },
          { membership_id: 2, user_sub: 'bob', user_email: 'bob@example.com', role: 'HELPER', name: 'Bob Helper' },
        ],
      });
    });

    it('lists the team to an organiser and rejects a bad event id or a non-organiser', async () => {
      const members = [{ membership_id: 1, user_sub: 'bob', user_email: 'bob@example.com', role: 'HELPER' }];
      isOrganiser();
      on(ROSTER, members);
      // The route enriches each row with a `name` looked up from Cognito
      // (mocked to `{}` above, so `AdminGetUserCommand` resolves with no
      // UserAttributes and the looked-up name falls back to '').
      assert.deepEqual(await request('GET', '/events/5/team-members', { token: 'alice' }), {
        status: 200,
        body: { members: members.map((member) => ({ ...member, name: '' })) },
      });

      assert.equal((await request('GET', '/events/zero/team-members', { token: 'alice' })).status, 400);

      db.clearRules();
      isNotOrganiser();
      assert.equal((await request('GET', '/events/5/team-members', { token: 'mallory' })).status, 403);
    });

    describe('DELETE /events/:eventId/team-members/:userSub', () => {
      const scriptTeam = (owner: string, memberRole: string | null) => {
        on(/SELECT organiser_sub FROM events/, [{ organiser_sub: owner }]);
        on(/SELECT role FROM event_team_memberships/, memberRole ? [{ role: memberRole }] : []);
        on(REVOKE, { affectedRows: 1 });
      };
      const REVOKE = /UPDATE event_team_memberships SET invite_status = 'REVOKED'/;
      const removed = () => sqlMatching(REVOKE).length === 1;

      it('revokes the membership, recording who removed them and when, instead of deleting it', async () => {
        scriptTeam('owner', 'HELPER');
        isOrganiser();

        assert.equal((await request('DELETE', '/events/5/team-members/bob', { token: 'alice' })).status, 204);

        assert.equal(sqlMatching(/DELETE FROM event_team_memberships/).length, 0);
        const revoke = sqlMatching(REVOKE)[0];
        assert.match(revoke?.sql ?? '', /revoked_at = CURRENT_TIMESTAMP, revoked_by_sub = \?/);
        assert.deepEqual(revoke?.params, ['alice', 5, 'bob']);
      });

      it('treats an already-revoked member as not on the team', async () => {
        scriptTeam('owner', null);
        assert.deepEqual(await request('DELETE', '/events/5/team-members/bob', { token: 'owner' }), {
          status: 404,
          body: { error: 'team_member_not_found' },
        });
        assert.match(sqlMatching(/SELECT role FROM event_team_memberships/)[0]?.sql ?? '', /invite_status <> 'REVOKED'/);
        assert.equal(removed(), false);
      });

      it('will not let an organiser remove themselves', async () => {
        const response = await request('DELETE', '/events/5/team-members/alice', { token: 'alice' });
        assert.deepEqual(response, { status: 400, body: { error: 'invalid_team_member_removal' } });
        assert.equal(calls.length, 0);
      });

      it('reports an unknown event or member', async () => {
        on(/SELECT organiser_sub FROM events/, []);
        assert.equal((await request('DELETE', '/events/5/team-members/bob', { token: 'alice' })).status, 404);

        db.clearRules();
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

        db.reset();
        scriptTeam('owner', 'ORGANISER');
        const allowed = await request('DELETE', '/events/5/team-members/carol', { token: 'owner' });
        assert.equal(allowed.status, 204);
        assert.deepEqual(sqlMatching(REVOKE)[0]?.params, ['owner', 5, 'carol']);
      });

      it('lets an accepted organiser remove a helper, but nobody else', async () => {
        scriptTeam('owner', 'HELPER');
        isOrganiser();
        assert.equal((await request('DELETE', '/events/5/team-members/bob', { token: 'alice' })).status, 204);

        db.reset();
        scriptTeam('owner', 'HELPER');
        isNotOrganiser();
        const refused = await request('DELETE', '/events/5/team-members/bob', { token: 'mallory' });
        assert.deepEqual(refused, { status: 403, body: { error: 'event_organiser_required' } });
        assert.equal(removed(), false);
      });
    });

    it('will not change the role of a revoked member', async () => {
      on(/SELECT organiser_sub FROM events/, [{ organiser_sub: 'owner' }]);
      on(/UPDATE event_team_memberships SET role = \?/, { affectedRows: 0 });

      const response = await request('PATCH', '/events/5/team-members/bob', { token: 'owner', body: { role: 'ORGANISER' } });

      assert.deepEqual(response, { status: 404, body: { error: 'team_member_not_found' } });
      assert.match(calls.at(-1)?.sql ?? '', /AND invite_status <> 'REVOKED'$/);
    });
  });

  describe('POST /events/:eventId/invitations', () => {
    const REOPEN = /UPDATE event_team_memberships SET user_email = \?, role = \?, invite_status = 'PENDING'/;
    const scriptInvite = (revokedRows = 0) => {
      isOrganiser();
      on(/SELECT organiser_sub FROM events/, [{ organiser_sub: 'owner' }]);
      on(REOPEN, { affectedRows: revokedRows });
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

      db.clearRules();
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

    it('re-invites a removed member by reopening their revoked row as pending', async () => {
      scriptInvite(1);
      cognitoSend.mock.mockImplementation(async () => ({
        Users: [{ Attributes: attributes('sub-bob', 'bob@example.com') }],
      }));

      const response = await invite({ email: 'bob@example.com', role: 'ORGANISER' });

      assert.deepEqual(response, { status: 201, body: { invited: true } });
      const reopen = sqlMatching(REOPEN)[0];
      assert.match(reopen?.sql ?? '', /responded_at = NULL WHERE event_id = \? AND user_sub = \? AND invite_status = 'REVOKED'$/);
      assert.doesNotMatch(reopen?.sql ?? '', /revoked_at|revoked_by_sub/, 'the last removal stays recorded');
      assert.deepEqual(reopen?.params, ['bob@example.com', 'ORGANISER', 'owner', 5, 'sub-bob']);
      assert.equal(sqlMatching(/INSERT INTO event_team_memberships/).length, 0);
    });

    it('reports 409 when the user is already invited or a member', async () => {
      isOrganiser();
      on(/SELECT organiser_sub FROM events/, [{ organiser_sub: 'owner' }]);
      on(REOPEN, { affectedRows: 0 });
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
