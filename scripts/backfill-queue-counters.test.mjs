import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { backfillQueueCounters } from './backfill-queue-counters.mjs';

function fakePool(ids, conflict = false) {
  const calls = [];
  let failed = false;
  const record = (sql, params = []) => calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
  const connection = {
    beginTransaction: async () => record('BEGIN'),
    commit: async () => record('COMMIT'),
    rollback: async () => record('ROLLBACK'),
    release: () => record('RELEASE'),
    query: async (sql, params) => {
      record(sql, params);
      return sql.includes('FOR UPDATE')
        ? [[{ queue_session_id: params[0] }]]
        : [[{ allocated: 9, served: 2 }]];
    },
    execute: async (sql, params) => {
      record(sql, params);
      if (conflict && !failed) {
        failed = true;
        throw Object.assign(new Error('deadlock'), { errno: 1213 });
      }
      return [{ affectedRows: 1 }];
    },
  };
  return {
    calls,
    getConnection: async () => connection,
    query: async (sql, params) => {
      record(sql, params);
      return [ids.filter(id => id > params[0]).slice(0, 100).map(queue_session_id => ({ queue_session_id }))];
    },
  };
}

describe('queue counter backfill', () => {
  it('does not open transactions for an empty database', async () => {
    const pool = fakePool([]);
    assert.equal(await backfillQueueCounters(pool), 0);
    assert.equal(pool.calls.some(call => call.sql === 'BEGIN'), false);
  });

  it('locks one session at a time and never locks the entry aggregate', async () => {
    const pool = fakePool([3, 8]);
    assert.equal(await backfillQueueCounters(pool), 2);
    assert.equal(pool.calls.filter(call => call.sql === 'COMMIT').length, 2);
    assert.equal(pool.calls.filter(call => call.sql === 'RELEASE').length, 2);
    const aggregates = pool.calls.filter(call => /MAX\(position\)/.test(call.sql));
    assert.equal(aggregates.length, 2);
    for (const aggregate of aggregates) {
      assert.doesNotMatch(aggregate.sql, /FOR UPDATE/);
      assert.match(aggregate.sql, /CASE WHEN admitted_at IS NOT NULL THEN position END/);
    }
    const updates = pool.calls.filter(call => /^UPDATE/.test(call.sql));
    assert.deepEqual(updates.map(call => call.params), [[9, 2, 3], [9, 2, 8]]);
    for (const update of updates) {
      assert.match(update.sql, /next_position = GREATEST\(next_position, \?\)/);
      assert.match(update.sql, /serving_position = GREATEST\(serving_position, \?\)/);
      assert.match(update.sql, /WHERE queue_session_id = \?$/);
    }
  });

  it('pages by primary key and resumes beyond each committed page', async () => {
    const pool = fakePool(Array.from({ length: 101 }, (_, index) => index + 1));
    assert.equal(await backfillQueueCounters(pool), 101);
    const pages = pool.calls.filter(call => /ORDER BY queue_session_id LIMIT 100/.test(call.sql));
    assert.deepEqual(pages.map(call => call.params), [[0], [100], [101]]);
  });

  it('retries a rolled-back session without advancing the cursor early', async () => {
    const pool = fakePool([3], true);
    assert.equal(await backfillQueueCounters(pool), 1);
    assert.equal(pool.calls.filter(call => call.sql === 'ROLLBACK').length, 1);
    assert.equal(pool.calls.filter(call => call.sql === 'COMMIT').length, 1);
    assert.equal(pool.calls.filter(call => call.sql === 'RELEASE').length, 2);
    assert.deepEqual(pool.calls.filter(call => /^UPDATE/.test(call.sql)).map(call => call.params), [[9, 2, 3], [9, 2, 3]]);
  });
});
