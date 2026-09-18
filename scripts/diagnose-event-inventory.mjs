import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config({ path: '.env', quiet: true });

const title = process.argv.slice(2).join(' ').trim();
if (!title) {
  console.error('Usage: node scripts/diagnose-event-inventory.mjs EVENT_TITLE');
  process.exitCode = 1;
} else {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'false' ? undefined : { rejectUnauthorized: false },
    connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT ?? 10_000),
  });
  try {
    const [rows] = await connection.query(
      `SELECT e.event_id, e.title, e.tier, e.status, e.total_seats,
              i.inventory_item_id, i.total_qty, i.reserved_qty, i.sold_qty,
              i.total_qty - i.reserved_qty - i.sold_qty AS available_qty,
              SUM(h.status = 'ACTIVE' AND h.expires_at > CURRENT_TIMESTAMP) AS active_holds
         FROM event_inventory.events e
         LEFT JOIN event_inventory.inventory_items i ON i.event_id = e.event_id
         LEFT JOIN event_inventory.inventory_holds h ON h.inventory_item_id = i.inventory_item_id
        WHERE e.title = ?
        GROUP BY e.event_id, e.title, e.tier, e.status, e.total_seats,
                 i.inventory_item_id, i.total_qty, i.reserved_qty, i.sold_qty`,
      [title],
    );
    console.log(JSON.stringify(rows, null, 2));
  } finally {
    await connection.end();
  }
}
