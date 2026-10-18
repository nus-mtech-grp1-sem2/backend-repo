import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type mysql from 'mysql2/promise';

const MAX_ATTEMPTS = 4;

function isLockConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, errno } = error as { code?: string; errno?: number };
  return code === 'ER_LOCK_DEADLOCK' || errno === 1213 ||
    code === 'ER_LOCK_WAIT_TIMEOUT' || errno === 1205;
}

/** Retry only rolled-back database work. Publish events and refill queues after
 * this returns, when the connection and all transaction locks are released. */
export async function withTransaction<T>(
  pool: Pick<mysql.Pool, 'getConnection'>,
  operation: (connection: mysql.PoolConnection) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await operation(connection);
      await connection.commit();
      return result;
    } catch (error) {
      // A lock timeout need not roll back the whole transaction. Never retry
      // if rollback itself fails or the commit outcome is ambiguous.
      await connection.rollback();
      if (!isLockConflict(error) || attempt >= MAX_ATTEMPTS) throw error;
    } finally {
      connection.release();
    }
    await delay(10 * 2 ** (attempt - 1) + randomInt(10));
  }
}
