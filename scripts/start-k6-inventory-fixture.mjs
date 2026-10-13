import { writeFile } from 'node:fs/promises';

import mysql from 'mysql2/promise';

process.env.NODE_ENV = 'test';
process.env.DB_NAME = 'event_inventory';
process.env.DB_SSL = 'false';

const { app, database, __setVerifierForTests } = await import('../services/inventory/src/index.ts');

__setVerifierForTests({
  verify: async (token) => {
    if (!token.startsWith('test-token:')) throw new Error('invalid test token');
    return { sub: token.slice('test-token:'.length) };
  },
});

const fixturePool = mysql.createPool({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  database: 'event_inventory',
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? '',
  connectionLimit: 2,
});

const [eventResult] = await fixturePool.execute(
  `INSERT INTO events (organiser_sub, title, venue, starts_at, total_seats, tier, status)
   VALUES ('k6-ci', 'K6 disposable concurrency fixture', 'CI', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY), 10, 'TIER1_GA', 'PUBLISHED')`,
);
const eventId = eventResult.insertId;
const [itemResult] = await fixturePool.execute(
  'INSERT INTO inventory_items (event_id, name, total_qty, price_cents) VALUES (?, ?, 10, 2500)',
  [eventId, 'K6 General Admission'],
);
const inventoryItemId = itemResult.insertId;
const port = Number(process.env.K6_FIXTURE_PORT ?? 3002);
const server = app.listen(port, '127.0.0.1');
await new Promise((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});

const environment = [
  `K6_FIXTURE_URL=http://127.0.0.1:${port}`,
  `K6_EVENT_ID=${eventId}`,
  `K6_INVENTORY_ITEM_ID=${inventoryItemId}`,
].join('\n') + '\n';
if (process.env.K6_FIXTURE_ENV_FILE) {
  await writeFile(process.env.K6_FIXTURE_ENV_FILE, environment, { mode: 0o600 });
}
console.log(`Disposable inventory fixture ready on port ${port} for event ${eventId}.`);

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`Stopping disposable inventory fixture (${signal}).`);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  try {
    await fixturePool.execute('DELETE FROM seats WHERE event_id = ?', [eventId]);
    await fixturePool.execute('DELETE FROM inventory_holds WHERE event_id = ?', [eventId]);
    await fixturePool.execute('DELETE FROM inventory_items WHERE event_id = ?', [eventId]);
    await fixturePool.execute('DELETE FROM events WHERE event_id = ?', [eventId]);
  } finally {
    await Promise.all([fixturePool.end(), database.end()]);
  }
  process.exit(0);
}

process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
