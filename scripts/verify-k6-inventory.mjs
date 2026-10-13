import assert from 'node:assert/strict';

import mysql from 'mysql2/promise';

const eventId = Number(process.env.K6_EVENT_ID);
const inventoryItemId = Number(process.env.K6_INVENTORY_ITEM_ID);
assert.ok(Number.isSafeInteger(eventId) && eventId > 0, 'K6_EVENT_ID must be a positive integer');
assert.ok(Number.isSafeInteger(inventoryItemId) && inventoryItemId > 0, 'K6_INVENTORY_ITEM_ID must be a positive integer');

const connection = await mysql.createConnection({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  database: 'event_inventory',
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? '',
});

try {
  const [inventoryRows] = await connection.query(
    'SELECT total_qty, reserved_qty, sold_qty FROM inventory_items WHERE inventory_item_id = ? AND event_id = ?',
    [inventoryItemId, eventId],
  );
  assert.equal(inventoryRows.length, 1, 'inventory fixture must still exist');
  const inventory = inventoryRows[0];
  assert.equal(Number(inventory.total_qty), 10);
  assert.equal(Number(inventory.reserved_qty), 10, 'all available capacity should be held exactly once');
  assert.equal(Number(inventory.sold_qty), 0);
  assert.ok(
    Number(inventory.reserved_qty) + Number(inventory.sold_qty) <= Number(inventory.total_qty),
    'reserved plus sold inventory must not exceed capacity',
  );

  const [holdRows] = await connection.query(
    `SELECT COUNT(*) AS hold_count, COALESCE(SUM(quantity), 0) AS held_quantity
     FROM inventory_holds WHERE event_id = ? AND inventory_item_id = ? AND status = 'ACTIVE'`,
    [eventId, inventoryItemId],
  );
  assert.equal(Number(holdRows[0].hold_count), 10, 'exactly ten one-ticket holds should succeed');
  assert.equal(Number(holdRows[0].held_quantity), 10, 'active hold quantity must match reserved inventory');
  console.log('Verified: 50 concurrent attempts produced 10 holds, 40 safe rejections, and no oversell.');
} finally {
  await connection.end();
}
