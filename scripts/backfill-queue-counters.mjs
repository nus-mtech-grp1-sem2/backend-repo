import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { withTransaction } from '../services/shared/src/transaction.ts';

/** Resume by session primary key; one session is the bounded lock unit. The
 * aggregate is a consistent read, never an entry-table FOR UPDATE scan. */
export async function backfillQueueCounters(pool) {
  let lastId = 0;
  let updated = 0;
  for (;;) {
    const [sessions] = await pool.query(
      'SELECT queue_session_id FROM `queue`.queue_sessions WHERE queue_session_id > ? ORDER BY queue_session_id LIMIT 100',
      [lastId],
    );
    if (sessions.length === 0) return updated;
    for (const session of sessions) {
      await withTransaction(pool, async connection => {
        const [current] = await connection.query(
          'SELECT queue_session_id FROM `queue`.queue_sessions WHERE queue_session_id = ? FOR UPDATE',
          [session.queue_session_id],
        );
        if (!current[0]) return;
        const [positions] = await connection.query(
          `SELECT COALESCE(MAX(position), 0) AS allocated,
             COALESCE(MAX(CASE WHEN admitted_at IS NOT NULL THEN position END), 0) AS served
           FROM \`queue\`.queue_entries WHERE queue_session_id = ?`, [session.queue_session_id],
        );
        await connection.execute(
          `UPDATE \`queue\`.queue_sessions
           SET next_position = GREATEST(next_position, ?),
               serving_position = GREATEST(serving_position, ?)
           WHERE queue_session_id = ?`,
          [positions[0].allocated, positions[0].served, session.queue_session_id],
        );
      });
      lastId = session.queue_session_id;
      updated += 1;
    }
    console.log(`Backfilled ${updated} queue sessions; last session ${lastId}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--apply')) {
    throw new Error('Pause old queue join/admission writers, then run node --import tsx scripts/backfill-queue-counters.mjs --apply');
  }
  if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_PASSWORD) {
    throw new Error('DB_HOST, DB_USER and DB_PASSWORD are required');
  }
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectionLimit: 1,
    ...(process.env.DB_SSL === 'false' ? {} : { ssl: { rejectUnauthorized: true } }),
  });
  try {
    console.log(`Queue counter backfill complete: ${await backfillQueueCounters(pool)} sessions.`);
  } finally {
    await pool.end();
  }
}
