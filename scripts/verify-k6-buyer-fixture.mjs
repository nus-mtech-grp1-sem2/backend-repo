import mysql from 'mysql2/promise';

const mode = process.argv[2];
if (!['queue', 'checkout', 'journey', 'mixed'].includes(mode)) throw new Error('invalid fixture mode');
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
        COUNT(DISTINCT position) AS positions, MIN(position) AS first_position, MAX(position) AS last_position
       FROM \`queue\`.queue_entries e
       INNER JOIN \`queue\`.queue_sessions s ON s.queue_session_id = e.queue_session_id
       WHERE s.event_id = ?`,
      [eventId],
    );
    const row = rows[0];
    if (Number(row.entries) !== 100 || Number(row.customers) !== 100 || Number(row.positions) !== 100 ||
        Number(row.first_position) !== 1 || Number(row.last_position) !== 100) {
      throw new Error(`queue invariant failed: ${JSON.stringify(row)}`);
    }
    console.log('Queue invariant verified: 100 unique buyers with 100 distinct positions (1-100).');
    process.exitCode = 0;
  } else {
    const expected = mode === 'checkout' ? 80 : mode === 'mixed' ? 200 : 20;
    const [orders] = await connection.query(
      `SELECT COUNT(*) AS orders, SUM(status = 'PAID') AS paid,
        (SELECT COUNT(*) FROM checkout.payments p
         INNER JOIN checkout.orders po ON po.order_id = p.order_id
         WHERE po.event_id = ?) AS payments,
        (SELECT COUNT(DISTINCT p.order_id) FROM checkout.payments p
         INNER JOIN checkout.orders po ON po.order_id = p.order_id
         WHERE po.event_id = ? AND p.status = 'CAPTURED') AS captured_orders,
        (SELECT COUNT(*) FROM event_inventory.inventory_holds h
         INNER JOIN checkout.orders ho ON ho.hold_id = h.hold_id
         WHERE ho.event_id = ? AND h.status = 'CONFIRMED') AS confirmed_holds,
        (SELECT COUNT(*) FROM \`queue\`.queue_entries e
         INNER JOIN \`queue\`.queue_sessions s ON s.queue_session_id = e.queue_session_id
         WHERE s.event_id = ? AND e.status = 'LEFT') AS released_buyers
       FROM checkout.orders WHERE event_id = ?`,
      [eventId, eventId, eventId, eventId, eventId],
    );
    const [inventory] = await connection.query(
      `SELECT sold_qty, reserved_qty FROM event_inventory.inventory_items
       WHERE event_id = ? LIMIT 1`,
      [eventId],
    );
    const row = orders[0];
    const item = inventory[0];
    const orderCount = Number(row.orders);
    const paidCount = Number(row.paid);
    const paymentCount = Number(row.payments);
    const soldCount = Number(item.sold_qty);
    const reservedCount = Number(item.reserved_qty);
    const checkoutValid = (mode === 'checkout' || mode === 'mixed') &&
      orderCount === expected && paidCount === expected &&
      paymentCount === paidCount && soldCount === paidCount &&
      Number(row.captured_orders) === expected && Number(row.confirmed_holds) === expected &&
      Number(row.released_buyers) === expected &&
      reservedCount === 0 && soldCount + reservedCount <= (mode === 'mixed' ? 300 : 100);
    const journeyValid = mode === 'journey' && orderCount === expected && paidCount === expected &&
      paymentCount === expected && reservedCount === 0;
    if (!checkoutValid && !journeyValid) {
      throw new Error(`checkout invariant failed: ${JSON.stringify({ row, item })}`);
    }
    if (mode === 'mixed') {
      const [queue] = await connection.query(
        `SELECT COUNT(*) AS entries, COUNT(DISTINCT e.customer_sub) AS customers,
           COUNT(DISTINCT e.position) AS positions, MIN(e.position) AS first_position,
           MAX(e.position) AS last_position, MAX(s.next_position) AS allocated
         FROM \`queue\`.queue_entries e
         JOIN \`queue\`.queue_sessions s ON s.queue_session_id = e.queue_session_id
         WHERE s.event_id = ?`, [eventId],
      );
      const row = queue[0];
      if (Number(row.entries) !== 500 || Number(row.customers) !== 500 || Number(row.positions) !== 500 ||
          Number(row.first_position) !== 1 || Number(row.last_position) !== 500 || Number(row.allocated) !== 500) {
        throw new Error(`mixed queue invariant failed: ${JSON.stringify(row)}`);
      }
      console.log('Mixed invariant verified: 300 joins plus 200 admitted buyers; 500 distinct positions.');
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
    console.log(`${mode} invariant verified: ${paidCount}/${orderCount} orders paid with one payment each.`);
  }
  const [bounds] = await connection.query(
    `SELECT COUNT(*) AS invalid FROM \`queue\`.queue_sessions s
     WHERE s.event_id = ? AND (s.serving_position > s.next_position OR EXISTS (
       SELECT 1 FROM \`queue\`.queue_entries e WHERE e.queue_session_id = s.queue_session_id
         AND (e.position > s.next_position OR (e.admitted_at IS NOT NULL AND e.position > s.serving_position))
     ))`, [eventId],
  );
  if (Number(bounds[0].invalid) !== 0) throw new Error('queue counter bounds failed');
} finally {
  await connection.end();
}
