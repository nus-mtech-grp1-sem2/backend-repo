import 'dotenv/config';
import mysql from 'mysql2/promise';

const apply = process.argv.includes('--apply');
const includeRelated = process.argv.includes('--include-related');
const configured = Boolean(
  process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD,
);

if (!configured) {
  console.error('Test-event cleanup skipped: database variables are not configured.');
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
    const [fixtures] = await connection.query(
      `SELECT event_id, title
       FROM events
       WHERE title REGEXP '^TDD-TEST-EVENT-[0-9]+-[0-9]+-[0-9]+$'
         AND organiser_sub = CONCAT(
           'tdd-organiser-',
           SUBSTRING(title, CHAR_LENGTH('TDD-TEST-EVENT-') + 1)
         )
       FOR UPDATE`,
    );
    const fixtureIds = fixtures.map((event) => Number(event.event_id));

    if (fixtureIds.length === 0) {
      console.log('Test-event cleanup: no matching fixtures found.');
      await connection.rollback();
    } else {
      const placeholders = fixtureIds.map(() => '?').join(', ');
      const activityChecks = [
        ['queue sessions', `SELECT DISTINCT event_id FROM \`queue\`.queue_sessions WHERE event_id IN (${placeholders})`],
        ['orders', `SELECT DISTINCT event_id FROM checkout.orders WHERE event_id IN (${placeholders})`],
        ['tickets', `SELECT DISTINCT event_id FROM ticketing.tickets WHERE event_id IN (${placeholders})`],
      ];
      const activityByEvent = new Map(fixtureIds.map((eventId) => [eventId, []]));
      for (const [label, sql] of activityChecks) {
        const [rows] = await connection.query(sql, fixtureIds);
        for (const row of rows) activityByEvent.get(Number(row.event_id))?.push(label);
      }
      const deletableIds = includeRelated
        ? fixtureIds
        : fixtureIds.filter((eventId) => activityByEvent.get(eventId)?.length === 0);
      const protectedIds = includeRelated
        ? []
        : fixtureIds.filter((eventId) => (activityByEvent.get(eventId)?.length ?? 0) > 0);

      console.log(
        `Test-event cleanup: found ${fixtureIds.length} fixture(s): ${fixtureIds.join(', ')}`,
      );
      for (const eventId of protectedIds) {
        console.log(
          `Test-event cleanup: preserving ${eventId} because it has ${activityByEvent
            .get(eventId)
            .join(', ')}.`,
        );
      }
      if (includeRelated) {
        console.log('Test-event cleanup: related fixture orders, tickets, and queues will also be deleted.');
      }
      if (deletableIds.length === 0) {
        console.log('Test-event cleanup: no dependency-free fixtures can be deleted.');
        await connection.rollback();
      } else {
        const deletablePlaceholders = deletableIds.map(() => '?').join(', ');
        console.log(`Test-event cleanup: safe to delete ${deletableIds.join(', ')}.`);
        if (!apply) {
          console.log('Dry run only. Pass --apply to delete these fixtures.');
          await connection.rollback();
        } else {
          if (includeRelated) {
            const [notificationTables] = await connection.query(
              `SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'notification' AND table_name = 'email_notifications' LIMIT 1`,
            );
            if (notificationTables.length > 0) {
              await connection.execute(
                `DELETE FROM notification.email_notifications
                 WHERE event_id IN (${deletablePlaceholders})`,
                deletableIds,
              );
            }
            await connection.execute(
              `DELETE FROM ticketing.check_in_logs
               WHERE ticket_id IN (
                 SELECT ticket_id FROM ticketing.tickets
                 WHERE event_id IN (${deletablePlaceholders})
               )`,
              deletableIds,
            );
            await connection.execute(
              `DELETE FROM ticketing.tickets WHERE event_id IN (${deletablePlaceholders})`,
              deletableIds,
            );
            await connection.execute(
              `DELETE FROM checkout.payments
               WHERE order_id IN (
                 SELECT order_id FROM checkout.orders
                 WHERE event_id IN (${deletablePlaceholders})
               )`,
              deletableIds,
            );
            await connection.execute(
              `DELETE FROM checkout.order_items
               WHERE order_id IN (
                 SELECT order_id FROM checkout.orders
                 WHERE event_id IN (${deletablePlaceholders})
               )`,
              deletableIds,
            );
            await connection.execute(
              `DELETE FROM checkout.orders WHERE event_id IN (${deletablePlaceholders})`,
              deletableIds,
            );
            await connection.execute(
              `DELETE FROM \`queue\`.queue_entries
               WHERE queue_session_id IN (
                 SELECT queue_session_id FROM \`queue\`.queue_sessions
                 WHERE event_id IN (${deletablePlaceholders})
               )`,
              deletableIds,
            );
            await connection.execute(
              `DELETE FROM \`queue\`.queue_sessions WHERE event_id IN (${deletablePlaceholders})`,
              deletableIds,
            );
          }
          const [gridTables] = await connection.query(
            `SELECT 1 FROM information_schema.tables
             WHERE table_schema = DATABASE() AND table_name = 'event_grid_settings' LIMIT 1`,
          );
          if (gridTables.length > 0) {
            await connection.execute(
              `DELETE FROM event_grid_settings WHERE event_id IN (${deletablePlaceholders})`,
              deletableIds,
            );
          }
          await connection.execute(
            `DELETE FROM seats WHERE event_id IN (${deletablePlaceholders})`,
            deletableIds,
          );
          await connection.execute(
            `DELETE FROM inventory_holds WHERE event_id IN (${deletablePlaceholders})`,
            deletableIds,
          );
          await connection.execute(
            `DELETE FROM inventory_items WHERE event_id IN (${deletablePlaceholders})`,
            deletableIds,
          );
          await connection.execute(
            `DELETE FROM event_team_memberships WHERE event_id IN (${deletablePlaceholders})`,
            deletableIds,
          );
          const [result] = await connection.execute(
            `DELETE FROM events WHERE event_id IN (${deletablePlaceholders})`,
            deletableIds,
          );
          await connection.commit();
          console.log(`Test-event cleanup: deleted ${result.affectedRows} fixture event(s).`);
        }
      }
    }
  } catch (error) {
    await connection.rollback();
    console.error('Test-event cleanup failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await connection.end();
  }
}
