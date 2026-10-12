import mysql from 'mysql2/promise';

const mode = process.argv[2];
if (!['queue', 'checkout', 'journey'].includes(mode)) throw new Error('invalid fixture mode');
const connection = await mysql.createConnection({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3307),
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? '',
});
const eventId = Number(process.env.K6_EVENT_ID);

try {
  if (mode === 'queue') {
    const [rows] = await connection.query(
      `SELECT COUNT(*) AS entries, COUNT(DISTINCT customer_sub) AS customers,
        COUNT(DISTINCT position) AS positions
       FROM \`queue\`.queue_entries e
       INNER JOIN \`queue\`.queue_sessions s ON s.queue_session_id = e.queue_session_id
       WHERE s.event_id = ?`,
      [eventId],
    );
    const row = rows[0];
    if (Number(row.entries) !== 100 || Number(row.customers) !== 100 || Number(row.positions) < 1) {
      throw new Error(`queue invariant failed: ${JSON.stringify(row)}`);
    }
    console.log(`Queue invariant verified: 100 unique buyers; ${row.positions} stored position values observed.`);
    process.exitCode = 0;
  } else {
    const expected = mode === 'checkout' ? 50 : 10;
    const [orders] = await connection.query(
      `SELECT COUNT(*) AS orders, SUM(status = 'PAID') AS paid,
        (SELECT COUNT(*) FROM checkout.payments p
         INNER JOIN checkout.orders po ON po.order_id = p.order_id
         WHERE po.event_id = ?) AS payments
       FROM checkout.orders WHERE event_id = ?`,
      [eventId, eventId],
    );
    const [inventory] = await connection.query(
      `SELECT sold_qty, reserved_qty FROM event_inventory.inventory_items
       WHERE event_id = ? LIMIT 1`,
      [eventId],
    );
    const row = orders[0];
    const item = inventory[0];
    if (Number(row.orders) !== expected || Number(row.paid) !== expected ||
        Number(row.payments) !== expected || Number(item.reserved_qty) !== 0 ||
        (mode === 'checkout' && Number(item.sold_qty) !== expected)) {
      throw new Error(`checkout invariant failed: ${JSON.stringify({ row, item })}`);
    }
    if (mode === 'journey') {
      const [queue] = await connection.query(
        `SELECT SUM(e.status = 'LEFT') AS released
         FROM \`queue\`.queue_entries e
         INNER JOIN \`queue\`.queue_sessions s ON s.queue_session_id = e.queue_session_id
         WHERE s.event_id = ?`,
        [eventId],
      );
      const [seats] = await connection.query(
        `SELECT SUM(status = 'SOLD') AS sold FROM event_inventory.seats WHERE event_id = ?`,
        [eventId],
      );
      if (Number(queue[0].released) !== expected || Number(seats[0].sold) !== expected) {
        throw new Error(`journey invariant failed: ${JSON.stringify({ queue: queue[0], seats: seats[0] })}`);
      }
    }
    console.log(`${mode} invariant verified: ${expected} paid orders with one payment each.`);
  }
} finally {
  await connection.end();
}
