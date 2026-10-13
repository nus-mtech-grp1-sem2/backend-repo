import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

import { installOfflineServices, startServer, type TestServer } from '../../test-support/offline-services.js';

// Nothing here can reach a real database or AWS: see test-support/offline-services.ts.
const db = installOfflineServices(mock, {
  env: { DB_NAME: 'event_inventory' },
  claims: (token) => ({ sub: token }),
});
const { calls, on } = db;

const { app } = await import('./index.js');

describe('PATCH /events/:eventId/seats (switch seats on or off)', () => {
  let server: TestServer;
  before(async () => { server = await startServer(app); });
  after(() => server.close());
  beforeEach(() => db.reset());

  const EVENT = /FROM events WHERE event_id = \? LIMIT 1/;
  const ORGANISER = /FROM event_team_memberships/;
  const SWITCH = /^UPDATE seats SET status = \?, tag = \?/;

  const switchSeats = async (body: unknown, token = 'organiser') => {
    const response = await fetch(`${server.base}/events/7/seats`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const scriptEvent = (overrides: Record<string, unknown> = {}) => {
    on(EVENT, [{ event_id: 7, status: 'DRAFT', tier: 'TIER2_SEATED', has_started: 0, ...overrides }]);
    on(ORGANISER, [{ membership_id: 1 }]);
    on(SWITCH, { affectedRows: 2 });
  };

  it('switches available seats off in one statement, leaving sold and held seats alone', async () => {
    scriptEvent();

    const response = await switchSeats({ seatIds: [101, 102, 103], available: false });

    assert.deepEqual(response, { status: 200, body: { updated: 2 } });
    const update = calls.find((call) => SWITCH.test(call.sql));
    assert.ok(update);
    assert.match(update.sql, /AND status = \? AND seat_id IN \(\?\)/);
    assert.deepEqual(update.params, ['BLOCKED', 'MAINTENANCE', 7, 'AVAILABLE', [101, 102, 103]]);
  });

  it('switches seats that were off back on', async () => {
    scriptEvent();

    await switchSeats({ seatIds: [104], available: true });

    const update = calls.find((call) => SWITCH.test(call.sql));
    assert.ok(update);
    assert.deepEqual(update.params, ['AVAILABLE', 'NONE', 7, 'BLOCKED', [104]]);
  });

  it('refuses anything but a list of seat ids and an on/off flag', async () => {
    for (const body of [
      { seatIds: [], available: false },
      { seatIds: [1], available: 'yes' },
      { seatIds: ['1'], available: true },
      { seatIds: [0], available: true },
      { seatIds: [true], available: true },
      { available: true },
    ]) {
      db.reset();
      scriptEvent();
      assert.deepEqual(await switchSeats(body), { status: 400, body: { error: 'invalid_seat_switch' } });
      assert.equal(calls.some((call) => SWITCH.test(call.sql)), false);
    }
  });

  it('only lets the event organiser switch seats', async () => {
    on(EVENT, [{ event_id: 7, status: 'DRAFT', tier: 'TIER2_SEATED', has_started: 0 }]);
    on(ORGANISER, []);

    const response = await switchSeats({ seatIds: [101], available: false }, 'stranger');

    assert.deepEqual(response, { status: 403, body: { error: 'event_organiser_required' } });
    assert.equal(calls.some((call) => SWITCH.test(call.sql)), false);
  });

  it('leaves a cancelled or already-started event as it is', async () => {
    for (const [event, error] of [
      [{ status: 'CANCELLED' }, 'event_cancelled'],
      [{ status: 'PUBLISHED', has_started: 1 }, 'event_completed'],
    ] as const) {
      db.reset();
      scriptEvent(event);
      assert.deepEqual(await switchSeats({ seatIds: [101], available: false }), { status: 409, body: { error } });
      assert.equal(calls.some((call) => SWITCH.test(call.sql)), false);
    }
  });
});
