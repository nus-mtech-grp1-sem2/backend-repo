import 'dotenv/config';
import mysql from 'mysql2/promise';

const apply = process.argv.includes('--apply');
const configured = Boolean(
  process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD,
);

if (!configured) {
  console.error('Waiting-room configuration skipped: database variables are not configured.');
  process.exitCode = 1;
} else {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME_EVENT_INVENTORY ?? 'event_inventory',
    connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT ?? 10_000),
    ...(process.env.DB_SSL === 'false' ? {} : { ssl: { rejectUnauthorized: false } }),
  });

  try {
    await connection.beginTransaction();
    const [events] = await connection.query(
      `SELECT e.event_id, e.title, e.starts_at, e.total_seats, e.available_buyers,
              q.queue_session_id, q.opens_at, q.admission_batch_size,
              q.admission_interval_sec, q.status AS queue_status
       FROM event_inventory.events e
       LEFT JOIN \`queue\`.queue_sessions q ON q.event_id = e.event_id
       WHERE e.tier = 'TIER2_SEATED'
         AND e.status = 'PUBLISHED'
         AND e.starts_at > CURRENT_TIMESTAMP
       ORDER BY e.starts_at, e.event_id
       FOR UPDATE`,
    );
    const missing = events.filter((event) => event.queue_session_id === null);

    console.log(`Waiting-room configuration: found ${events.length} current reserved event(s).`);
    for (const event of events) {
      const totalSeats = Number(event.total_seats);
      const configuredBuyers =
        event.available_buyers === null ? Math.ceil(totalSeats * 0.1) : Number(event.available_buyers);
      const capacity = Math.min(totalSeats, Math.max(1, configuredBuyers));
      console.log(
        `- ${event.event_id}: ${event.title} — ${
          event.queue_session_id === null
            ? `missing; will open with ${capacity} concurrent buyer(s)`
            : `already ${event.queue_status}; preserving session ${event.queue_session_id}`
        }`,
      );
    }

    if (missing.length === 0) {
      console.log('Waiting-room configuration: all current reserved events are already configured.');
      await connection.rollback();
    } else if (!apply) {
      console.log('Dry run only. Pass --apply to create the missing waiting rooms.');
      await connection.rollback();
    } else {
      for (const event of missing) {
        const totalSeats = Number(event.total_seats);
        const configuredBuyers =
          event.available_buyers === null
            ? Math.ceil(totalSeats * 0.1)
            : Number(event.available_buyers);
        const capacity = Math.min(totalSeats, Math.max(1, configuredBuyers));
        await connection.execute(
          `INSERT IGNORE INTO \`queue\`.queue_sessions
             (event_id, opens_at, admission_batch_size, admission_interval_sec, status)
           VALUES (?, CURRENT_TIMESTAMP, ?, 60, 'OPEN')`,
          [event.event_id, capacity],
        );
      }
      await connection.commit();
      console.log(`Waiting-room configuration: created ${missing.length} waiting room(s).`);
    }
  } catch (error) {
    await connection.rollback();
    console.error(
      'Waiting-room configuration failed:',
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  } finally {
    await connection.end();
  }
}
