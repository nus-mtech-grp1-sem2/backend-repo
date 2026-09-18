import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'mysql2/promise';
import { acceptInvitation, rejectInvitation } from './lifecycle.js';

test('invitation mutation rolls back audit/write failures and releases connection', async () => {
  for (const mutate of [acceptInvitation, rejectInvitation]) {
    const calls: string[] = [];
    const connection = {
      beginTransaction: async () => { calls.push('begin'); },
      query: async () => [[{ invitation_id: 1, status: 'PENDING', user_id: 2, event_id: 12, role: 'event_helper', invited_by_sub: 'owner' }]],
      execute: async (sql: string) => { if (sql.includes('audit_records')) throw new Error('audit unavailable'); return [{ affectedRows: 1 }]; },
      commit: async () => { calls.push('commit'); },
      rollback: async () => { calls.push('rollback'); },
      release: () => { calls.push('release'); },
    };
    const pool = { getConnection: async () => connection } as unknown as Pool;
    await assert.rejects(mutate(pool, 1, 'invitee', 'issuer', 'request'), /audit unavailable/);
    assert.deepEqual(calls, ['begin', 'rollback', 'release']);
  }
});

test('invitation replay never reactivates a subsequently revoked assignment', async () => {
  let writes = 0;
  const connection = {
    beginTransaction: async () => {},
    query: async () => [[{ status: 'ACCEPTED' }]],
    execute: async () => { writes++; },
    commit: async () => {}, rollback: async () => {}, release: () => {},
  };
  assert.equal(await acceptInvitation({ getConnection: async () => connection } as unknown as Pool, 1, 'invitee', 'issuer', 'retry'), true);
  assert.equal(writes, 0);
});
