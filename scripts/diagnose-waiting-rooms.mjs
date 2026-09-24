import 'dotenv/config';
import mysql from 'mysql2/promise';

const connection = await mysql.createConnection({
  host: process.env.DB_HOST ?? '',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? '',
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME_EVENT_INVENTORY ?? 'event_inventory',
  connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT ?? 10_000),
  ...(process.env.DB_SSL === 'false' ? {} : { ssl: { rejectUnauthorized: false } }),
});

try {
  const [queues] = await connection.query(
    `SELECT ev.event_id, ev.title, ev.available_buyers,
            CASE
              WHEN ev.available_buyers IS NOT NULL THEN LEAST(ev.available_buyers, ev.total_seats)
              ELSE GREATEST(1, CEIL(ev.total_seats * 0.1))
            END AS buyer_capacity,
            s.status AS queue_status,
            SUM(qe.status IN ('ADMITTED', 'IN_CHECKOUT')) AS active_buyers,
            SUM(qe.status = 'ADMITTED') AS admitted_buyers,
            SUM(qe.status = 'IN_CHECKOUT') AS checkout_buyers,
            SUM(qe.status = 'WAITING') AS waiting_customers
     FROM event_inventory.events ev
     INNER JOIN \`queue\`.queue_sessions s ON s.event_id = ev.event_id
     LEFT JOIN \`queue\`.queue_entries qe ON qe.queue_session_id = s.queue_session_id
     WHERE ev.tier = 'TIER2_SEATED' AND ev.status = 'PUBLISHED'
     GROUP BY ev.event_id, ev.title, ev.available_buyers, ev.total_seats, s.status
     ORDER BY ev.event_id`,
  );
  for (const queue of queues) {
    console.log(
      `${queue.event_id}: ${queue.title} | capacity=${queue.buyer_capacity} active=${Number(
        queue.active_buyers ?? 0,
      )} admitted=${Number(queue.admitted_buyers ?? 0)} checkout=${Number(
        queue.checkout_buyers ?? 0,
      )} waiting=${Number(queue.waiting_customers ?? 0)} status=${queue.queue_status}`,
    );
  }
} finally {
  await connection.end();
}
