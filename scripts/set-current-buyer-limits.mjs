import 'dotenv/config';
import mysql from 'mysql2/promise';

const apply = process.argv.includes('--apply');
const buyersArgument = process.argv.find((argument) => argument.startsWith('--buyers='));
const buyers = Number(buyersArgument?.split('=', 2)[1]);

if (!Number.isSafeInteger(buyers) || buyers < 1) {
  console.error('Usage: node scripts/set-current-buyer-limits.mjs --buyers=<positive integer> [--apply]');
  process.exitCode = 1;
} else {
  const configured = Boolean(
    process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD,
  );
  if (!configured) {
    console.error('Buyer-limit update skipped: database variables are not configured.');
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
        `SELECT event_id, title, tier, starts_at, available_buyers
         FROM event_inventory.events
         WHERE status = 'PUBLISHED' AND starts_at > CURRENT_TIMESTAMP
         ORDER BY starts_at, event_id
         FOR UPDATE`,
      );

      console.log(`Buyer-limit update: found ${events.length} current event(s).`);
      for (const event of events) {
        console.log(
          `- ${event.event_id}: ${event.title} (${event.tier}) ${event.available_buyers ?? 'default'} -> ${buyers}`,
        );
      }

      if (!apply) {
        console.log('Dry run only. Pass --apply to update these events.');
        await connection.rollback();
      } else {
        await connection.execute(
          `UPDATE event_inventory.events
           SET available_buyers = ?
           WHERE status = 'PUBLISHED' AND starts_at > CURRENT_TIMESTAMP`,
          [buyers],
        );
        await connection.execute(
          `UPDATE \`queue\`.queue_sessions q
           INNER JOIN event_inventory.events e ON e.event_id = q.event_id
           SET q.admission_batch_size = ?
           WHERE e.status = 'PUBLISHED' AND e.starts_at > CURRENT_TIMESTAMP`,
          [buyers],
        );
        await connection.commit();
        console.log(`Buyer-limit update: set ${events.length} current event(s) to ${buyers}.`);
      }
    } catch (error) {
      await connection.rollback();
      console.error('Buyer-limit update failed:', error instanceof Error ? error.message : error);
      process.exitCode = 1;
    } finally {
      await connection.end();
    }
  }
}
