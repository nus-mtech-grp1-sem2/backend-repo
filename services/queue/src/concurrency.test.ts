import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import { SQSClient } from '@aws-sdk/client-sqs';
import { installOfflineServices, startServer, type TestServer } from '../../test-support/offline-services.js';

const db = installOfflineServices(mock, {
  env: {
    DB_NAME: 'queue', INTERNAL_API_TOKEN: 'test-internal-token', AUTO_ADMISSION_ENABLED: 'true',
    CUSTOMER_ADMITTED_QUEUE_URL: 'https://sqs.invalid/admitted',
  },
  claims: token => ({ sub: token }),
});
const sends: unknown[] = [];
const send = mock.method(SQSClient.prototype, 'send', async (command: unknown) => {
  sends.push(command);
  return {};
});
const { app, database, runAdmissionSweep } = await import('./index.js');

describe('queue transaction concurrency guards', () => {
  let server: TestServer;
  before(async () => { server = await startServer(app); });
  after(() => server.close());
  beforeEach(() => {
    db.reset();
    sends.length = 0;
    send.mock.mockImplementation(async (command: unknown) => { sends.push(command); return {}; });
  });

  const entry = { queue_entry_id: 7, customer_sub: 'alice', position: 45, status: 'WAITING', admission_token: null, token_expires_at: null };
  const post = (path: string) => fetch(`${server.base}/events/5/queue/${path}`, {
    method: 'POST', headers: { authorization: 'Bearer alice', 'x-internal-token': 'test-internal-token' },
  });

  function scriptJoin(existing: unknown[] = []) {
    db.on(/FROM queue_sessions WHERE event_id/, [{ queue_session_id: 1, status: 'OPEN', next_position: 44, serving_position: 30 }]);
    db.on(/FROM event_inventory\.events WHERE event_id/, [{ status: 'PUBLISHED', has_started: 0, total_seats: 100 }]);
    db.on(/FROM queue_entries WHERE queue_session_id/, existing);
    db.on(/FROM queue_entries WHERE queue_entry_id/, existing);
    db.on(/UPDATE queue_sessions SET next_position/, { affectedRows: 1 });
    db.on(/INSERT INTO queue_entries/, { insertId: 7 });
  }

  async function failOnce(context: { mock: typeof mock }, pattern: RegExp, errno = 1213) {
    const connection = await database.getConnection();
    const execute = connection.execute.bind(connection);
    let failed = false;
    context.mock.method(connection, 'execute', async (sql: string, params: unknown[]) => {
      if (pattern.test(sql) && !failed) {
        failed = true;
        throw Object.assign(new Error('lock conflict'), { errno });
      }
      return execute(sql, params);
    });
  }

  it('allocates a ticket without scanning or locking other buyers', async () => {
    scriptJoin();
    const response = await post('join');
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { queueEntryId: 7, status: 'WAITING', position: 15 });
    assert.equal(db.calls.some(call => /MAX\(position\)|COUNT\(\*\)/.test(call.sql)), false);
    assert.equal(db.calls.filter(call => /FOR UPDATE/.test(call.sql)).length, 1);
    assert.match(db.calls[1]?.sql ?? '', /FROM queue_sessions.*FOR UPDATE$/);
    assert.deepEqual(db.calls.find(call => /INSERT INTO queue_entries/.test(call.sql))?.params, [1, 'alice', 45]);
  });

  it('rechecks an existing buyer only by primary key and preserves idempotency', async () => {
    scriptJoin([entry]);
    const response = await post('join');
    assert.equal(response.status, 200);
    assert.equal(db.calls.some(call => /^(INSERT|UPDATE)/.test(call.sql)), false);
    assert.ok(db.calls.some(call => /WHERE queue_entry_id = \? LIMIT 1 FOR UPDATE$/.test(call.sql)));
    assert.equal(db.calls.some(call => /customer_sub.*FOR UPDATE/.test(call.sql)), false);
  });

  for (const errno of [1213, 1205]) {
    it(`retries the whole join after ${errno}, committing only one ticket`, async context => {
      scriptJoin();
      await failOnce(context, /INSERT INTO queue_entries/, errno);
      assert.equal((await post('join')).status, 201);
      assert.equal(db.calls.filter(call => call.sql === 'BEGIN').length, 2);
      assert.equal(db.calls.filter(call => call.sql === 'ROLLBACK').length, 1);
      assert.equal(db.calls.filter(call => call.sql === 'COMMIT').length, 1);
      assert.equal(db.calls.filter(call => /SET next_position/.test(call.sql)).length, 2);
    });
  }

  it('does not retry a business rejection or allocate a ticket', async () => {
    db.on(/FROM queue_sessions/, [{ queue_session_id: 1, status: 'DRAINED' }]);
    db.on(/FROM event_inventory\.events/, [{ status: 'PUBLISHED', has_started: 0 }]);
    const response = await post('join');
    assert.equal(response.status, 409);
    assert.equal(db.calls.filter(call => call.sql === 'BEGIN').length, 1);
    assert.equal(db.calls.some(call => /^UPDATE|^INSERT/.test(call.sql)), false);
  });

  function scriptBuyer(status = 'WAITING') {
    db.on(/FROM queue_sessions/, [{ queue_session_id: 1, serving_position: 30 }]);
    db.on(/FROM queue_entries WHERE queue_session_id/, [{ ...entry, status }]);
    db.on(/FROM queue_entries WHERE queue_entry_id/, [{ ...entry, status }]);
    db.on(/UPDATE queue_entries/, { affectedRows: 1 });
  }

  it('polls an upper-bound position without COUNT or session-locking UPDATEs', async context => {
    scriptBuyer();
    await failOnce(context, /UPDATE queue_entries/);
    const response = await fetch(`${server.base}/events/5/queue/me`, { headers: { authorization: 'Bearer alice' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { queueEntryId: 7, status: 'WAITING', position: 15 });
    assert.equal(db.calls.some(call => /COUNT\(|JOIN|FOR UPDATE/.test(call.sql)), false);
    const expiry = db.calls.find(call => /^UPDATE/.test(call.sql));
    assert.match(expiry?.sql ?? '', /WHERE queue_entry_id = \?.*token_expires_at <= CURRENT_TIMESTAMP$/);
    assert.deepEqual(expiry?.params, [7]);
    assert.equal(db.calls.filter(call => call.sql === 'ROLLBACK').length, 1);
  });

  it('leaves by primary key without taking a session lock', async () => {
    scriptBuyer();
    const response = await fetch(`${server.base}/events/5/queue/me`, { method: 'DELETE', headers: { authorization: 'Bearer alice' } });
    assert.equal(response.status, 204);
    assert.equal(db.calls.some(call => /JOIN|queue_sessions.*FOR UPDATE/.test(call.sql)), false);
    assert.match(db.calls.find(call => /^UPDATE/.test(call.sql))?.sql ?? '', /WHERE queue_entry_id = \?$/);
  });

  it('still refuses to leave a checkout that acquired the buyer row first', async () => {
    scriptBuyer('IN_CHECKOUT');
    const response = await fetch(`${server.base}/events/5/queue/me`, { method: 'DELETE', headers: { authorization: 'Bearer alice' } });
    assert.equal(response.status, 409);
    assert.equal(db.calls.some(call => /^UPDATE/.test(call.sql)), false);
  });

  function scriptAdmission() {
    db.on(/FROM queue_sessions WHERE event_id/, [{ queue_session_id: 1, status: 'OPEN', admission_interval_sec: 1 }]);
    db.on(/MAX\(admitted_at\)/, [{ last_admitted_at: null }]);
    db.on(/FROM event_inventory\.events e/, [{ status: 'PUBLISHED', tier: 'TIER1_GA', total_seats: 100, available_buyers: 20, available_qty: 100 }]);
    db.on(/SELECT queue_entry_id FROM queue_entries/, [{ queue_entry_id: 8 }]);
    db.on(/UPDATE queue_entries SET status = 'EXPIRED'/, { affectedRows: 1 });
    db.on(/SUM\(status IN/, [{ active_buyers: 0, remaining: 2 }]);
    db.on(/ORDER BY position, queue_entry_id LIMIT/, [
      { ...entry, queue_entry_id: 3, position: 45 },
      { ...entry, queue_entry_id: 2, customer_sub: 'bob', position: 46 },
    ]);
    db.on(/UPDATE queue_entries SET status = 'ADMITTED'/, { affectedRows: 1 });
    db.on(/UPDATE queue_sessions SET serving_position/, { affectedRows: 1 });
    db.on(/SELECT COUNT\(\*\) AS remaining/, [{ remaining: 0 }]);
  }

  it('expires and admits using primary-key updates, then advances the serving counter', async context => {
    scriptAdmission();
    await failOnce(context, /SET status = 'ADMITTED'/);
    let released = false;
    const connection = await database.getConnection();
    context.mock.method(connection, 'release', () => { released = true; });
    send.mock.mockImplementation(async (command: unknown) => {
      assert.equal(released, true, 'publish only after the connection is released');
      assert.equal(db.calls.at(-1)?.sql, 'COMMIT');
      sends.push(command);
      return {};
    });
    const response = await post('admit-next');
    assert.equal(response.status, 200);
    const body = await response.json() as { admitted: number; eventsPublished: number };
    assert.equal(body.admitted, 2);
    assert.equal(body.eventsPublished, 2);
    assert.equal(sends.length, 1);
    assert.equal(db.calls.filter(call => call.sql === 'COMMIT').length, 1);
    assert.equal(db.calls.filter(call => call.sql === 'ROLLBACK').length, 1);
    const updates = db.calls.filter(call => /UPDATE queue_entries/.test(call.sql));
    for (const update of updates) assert.match(update.sql, /WHERE queue_entry_id = \?/);
    assert.deepEqual(updates.filter(call => /SET status = 'ADMITTED'/.test(call.sql)).map(call => call.params[3]), [2, 3]);
    assert.deepEqual(db.calls.find(call => /SET serving_position/.test(call.sql))?.params, [46, 1]);
    assert.match(db.calls.find(call => /AS active_buyers/.test(call.sql))?.sql ?? '',
      /SUM\(status IN \('ADMITTED', 'IN_CHECKOUT'\) AND token_expires_at > CURRENT_TIMESTAMP\)/);
    assert.equal(db.calls.some(call => /FROM queue_entries.*FOR UPDATE/.test(call.sql)), false);
  });

  it('does not replay committed admissions when SQS publication fails', async () => {
    scriptAdmission();
    send.mock.mockImplementation(async () => { throw Object.assign(new Error('publication failed'), { errno: 1213 }); });
    const response = await post('admit-next');
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { eventPublication: string }).eventPublication, 'failed');
    assert.equal(db.calls.filter(call => call.sql === 'BEGIN').length, 1);
    assert.equal(db.calls.some(call => call.sql === 'ROLLBACK'), false);
  });

  it('retries the bounded scheduler expiry batch without locking a secondary scan', async context => {
    db.on(/SELECT queue_entry_id FROM queue_entries/, [{ queue_entry_id: 8 }]);
    db.on(/UPDATE queue_entries/, { affectedRows: 1 });
    db.on(/SELECT s.event_id/, []);
    await failOnce(context, /UPDATE queue_entries/);
    assert.equal(await runAdmissionSweep(), 0);
    assert.equal(db.calls.filter(call => call.sql === 'ROLLBACK').length, 1);
    assert.equal(db.calls.some(call => /FOR UPDATE/.test(call.sql)), false);
    assert.ok(db.calls.some(call => /ORDER BY queue_entry_id LIMIT 200$/.test(call.sql)));
  });
});
