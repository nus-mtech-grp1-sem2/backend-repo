import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type mysql from 'mysql2/promise';

import { withTransaction } from './transaction.js';

function fakePool(rollbackError?: Error) {
  const events: string[] = [];
  let connections = 0;
  const pool = {
    getConnection: async () => {
      const id = ++connections;
      events.push(`acquire:${id}`);
      return {
        beginTransaction: async () => { events.push(`begin:${id}`); },
        commit: async () => { events.push(`commit:${id}`); },
        rollback: async () => {
          events.push(`rollback:${id}`);
          if (rollbackError) throw rollbackError;
        },
        release: () => { events.push(`release:${id}`); },
      } as mysql.PoolConnection;
    },
  };
  return { pool, events };
}

describe('transaction lock retries', () => {
  for (const conflict of [
    { code: 'ER_LOCK_DEADLOCK', errno: 1213 },
    { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 },
    { errno: 1213 },
    { errno: 1205 },
  ]) {
    it(`rolls back and releases before retrying ${JSON.stringify(conflict)}`, async () => {
      const { pool, events } = fakePool();
      let attempts = 0;
      const result = await withTransaction(pool, async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('lock conflict'), conflict);
        return 42;
      });

      assert.equal(result, 42);
      assert.deepEqual(events, [
        'acquire:1', 'begin:1', 'rollback:1', 'release:1',
        'acquire:2', 'begin:2', 'commit:2', 'release:2',
      ]);
    });
  }

  it('stops after four failed attempts without committing', async () => {
    const { pool, events } = fakePool();
    const conflict = Object.assign(new Error('deadlock'), { errno: 1213 });

    await assert.rejects(withTransaction(pool, async () => { throw conflict; }), (error) => error === conflict);

    assert.equal(events.filter((event) => event.startsWith('rollback:')).length, 4);
    assert.equal(events.filter((event) => event.startsWith('release:')).length, 4);
    assert.equal(events.some((event) => event.startsWith('commit:')), false);
  });

  it('does not retry business errors or an ambiguous connection failure', async () => {
    for (const code of ['inventory_unavailable', 'PROTOCOL_CONNECTION_LOST', 'ER_DUP_ENTRY']) {
      const { pool, events } = fakePool();
      const failure = Object.assign(new Error(code), { code });

      await assert.rejects(withTransaction(pool, async () => { throw failure; }), (error) => error === failure);

      assert.deepEqual(events, ['acquire:1', 'begin:1', 'rollback:1', 'release:1']);
    }
  });

  it('releases the connection but refuses to retry after rollback fails', async () => {
    const rollbackError = new Error('connection lost during rollback');
    const { pool, events } = fakePool(rollbackError);

    await assert.rejects(
      withTransaction(pool, async () => { throw Object.assign(new Error('deadlock'), { errno: 1213 }); }),
      (error) => error === rollbackError,
    );

    assert.deepEqual(events, ['acquire:1', 'begin:1', 'rollback:1', 'release:1']);
  });
});
