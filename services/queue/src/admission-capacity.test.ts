import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import mysql from 'mysql2/promise';

// Exercise the real MySQL predicate and HTTP handler, not scripted SQL results.
// Never load deployment credentials or run these fixtures on a remote database.
if (!['127.0.0.1', 'localhost'].includes(process.env.DB_HOST ?? '')) {
  throw new Error('Queue capacity regression tests require an explicitly configured local test database');
}
Object.assign(process.env, {
  NODE_ENV: 'test', DB_NAME: 'queue', AUTO_ADMISSION_ENABLED: 'false',
  INTERNAL_API_TOKEN: 'queue-capacity-regression', CUSTOMER_ADMITTED_QUEUE_URL: '',
  COGNITO_USER_POOL_ID: '', COGNITO_CLIENT_ID: '',
});
const fixturePool = mysql.createPool({
  host: process.env.DB_HOST,
  database: 'queue',
  port: Number(process.env.DB_PORT ?? 3307),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  timezone: 'Z',
  connectionLimit: 2,
  ...(process.env.DB_SSL === 'false' ? {} : { ssl: { rejectUnauthorized: true } }),
});
const { app, database } = await import('./index.js');
let server: Server;
let baseUrl: string;
const events: number[] = [];

interface AdmissionFixture {
  readonly eventId: number;
  readonly sessionId: number;
}

async function createFixture(
  capacity: number,
  expiredStatus: 'ADMITTED' | 'IN_CHECKOUT',
  expiredCount: number,
  waitingCount: number,
  liveAdmitted = 0,
  liveCheckout = 0,
): Promise<AdmissionFixture> {
  const totalTickets = Math.max(2000, capacity * 2);
  const [event] = await fixturePool.execute<mysql.ResultSetHeader>(
    `INSERT INTO event_inventory.events
       (organiser_sub, title, venue, starts_at, total_seats, available_buyers, tier, status)
     VALUES ('capacity-regression', 'Admission expiry regression', 'Local test',
       DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY), ?, ?, 'TIER1_GA', 'PUBLISHED')`,
    [totalTickets, capacity],
  );
  events.push(event.insertId);
  await fixturePool.execute(
    `INSERT INTO event_inventory.inventory_items (event_id, name, total_qty, price_cents)
     VALUES (?, 'Regression tickets', ?, 2500)`, [event.insertId, totalTickets],
  );
  const previouslyAdmitted = expiredCount + liveAdmitted + liveCheckout;
  const [session] = await fixturePool.execute<mysql.ResultSetHeader>(
    `INSERT INTO \`queue\`.queue_sessions
       (event_id, opens_at, admission_batch_size, admission_interval_sec, status, next_position, serving_position)
     VALUES (?, UTC_TIMESTAMP(), ?, 1, 'OPEN', ?, ?)`,
    [event.insertId, capacity, previouslyAdmitted + waitingCount, previouslyAdmitted],
  );
  const entries: unknown[][] = [];
  function addEntries(count: number, status: string, expiry: string | null) {
    for (let index = 0; index < count; index += 1) {
      const position = entries.length + 1;
      entries.push([
        session.insertId, `capacity-buyer-${position}`, position, status,
        status === 'WAITING' ? null : '2000-01-01 00:00:00',
        status === 'WAITING' ? null : `capacity-token-${position}`, expiry,
      ]);
    }
  }
  addEntries(expiredCount, expiredStatus, '2000-01-01 00:00:00');
  addEntries(liveAdmitted, 'ADMITTED', '2099-01-01 00:00:00');
  addEntries(liveCheckout, 'IN_CHECKOUT', '2099-01-01 00:00:00');
  addEntries(waitingCount, 'WAITING', null);
  await fixturePool.query(
    `INSERT INTO \`queue\`.queue_entries
       (queue_session_id, customer_sub, position, status, admitted_at, admission_token, token_expires_at)
     VALUES ?`, [entries],
  );
  return { eventId: event.insertId, sessionId: session.insertId };
}

async function admit(fixture: AdmissionFixture) {
  const response = await fetch(`${baseUrl}/events/${fixture.eventId}/queue/admit-next`, {
    method: 'POST', headers: { 'x-internal-token': 'queue-capacity-regression' },
  });
  assert.equal(response.status, 200);
  return await response.json() as { admitted: number; remaining: number; reason?: string };
}

async function counts(fixture: AdmissionFixture) {
  const [rows] = await fixturePool.query<mysql.RowDataPacket[]>(
    `SELECT SUM(status IN ('ADMITTED', 'IN_CHECKOUT') AND token_expires_at > CURRENT_TIMESTAMP) AS live,
       SUM(status IN ('ADMITTED', 'IN_CHECKOUT') AND token_expires_at <= CURRENT_TIMESTAMP) AS stale,
       SUM(status = 'EXPIRED') AS cleaned, SUM(status = 'WAITING') AS waiting
     FROM \`queue\`.queue_entries WHERE queue_session_id = ?`, [fixture.sessionId],
  );
  const row = rows[0];
  return { live: Number(row?.live), stale: Number(row?.stale), cleaned: Number(row?.cleaned), waiting: Number(row?.waiting) };
}

describe('admission capacity with an expiry backlog (real MySQL)', () => {
  before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    try {
      for (const eventId of events) {
        await fixturePool.execute(
          `DELETE e FROM \`queue\`.queue_entries e
           JOIN \`queue\`.queue_sessions s ON s.queue_session_id = e.queue_session_id WHERE s.event_id = ?`, [eventId],
        );
        await fixturePool.execute('DELETE FROM `queue`.queue_sessions WHERE event_id = ?', [eventId]);
        await fixturePool.execute('DELETE FROM event_inventory.inventory_items WHERE event_id = ?', [eventId]);
        await fixturePool.execute('DELETE FROM event_inventory.events WHERE event_id = ?', [eventId]);
      }
    } finally {
      await Promise.all([fixturePool.end(), database.end()]);
    }
  });

  for (const status of ['ADMITTED', 'IN_CHECKOUT'] as const) {
    it(`admits all 1000 waiting buyers despite 1000 expired ${status} entries`, async () => {
      const fixture = await createFixture(1000, status, 1000, 1000);
      assert.deepEqual(await admit(fixture), { admitted: 1000, remaining: 0, eventsPublished: 0, eventPublication: 'disabled' });
      assert.deepEqual(await counts(fixture), { live: 1000, stale: 800, cleaned: 200, waiting: 0 });
      // Capacity is correct without extending cleanup beyond its bounded batch.
    });
  }

  it('still counts valid admitted and in-checkout buyers against the cap', async () => {
    const fixture = await createFixture(20, 'ADMITTED', 500, 40, 6, 4);
    const result = await admit(fixture);
    assert.equal(result.admitted, 10);
    assert.equal(result.remaining, 30);
    assert.deepEqual(await counts(fixture), { live: 20, stale: 300, cleaned: 200, waiting: 30 });
  });

  it('admits nobody when live buyers already fill capacity', async () => {
    const fixture = await createFixture(20, 'IN_CHECKOUT', 500, 10, 10, 10);
    assert.deepEqual(await admit(fixture), { admitted: 0, remaining: 10, reason: 'capacity_reached' });
    assert.deepEqual(await counts(fixture), { live: 20, stale: 300, cleaned: 200, waiting: 10 });
  });
});
