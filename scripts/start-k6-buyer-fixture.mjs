import { writeFile } from 'node:fs/promises';

import mysql from 'mysql2/promise';

const mode = process.argv[2];
if (!['queue', 'checkout', 'journey', 'mixed'].includes(mode)) {
  throw new Error('usage: start-k6-buyer-fixture.mjs <queue|checkout|journey|mixed>');
}

process.env.NODE_ENV = 'test';
process.env.DB_SSL = 'false';
process.env.INTERNAL_API_TOKEN = 'k6-fixture-internal';
process.env.ORDER_EVENTS_QUEUE_URL = '';
process.env.PAYMENT_REQUESTS_QUEUE_URL = '';
process.env.CUSTOMER_ADMITTED_QUEUE_URL = '';
process.env.TICKET_SERVICE_URL = '';
process.env.QUEUE_SERVICE_URL = '';

const connectionOptions = {
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3307),
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? '',
  connectionLimit: 4,
};
const fixturePool = mysql.createPool(connectionOptions);
const servers = [];
const pools = [];
const queuePort = Number(process.env.K6_FIXTURE_QUEUE_PORT ?? 3103);
const orderPort = Number(process.env.K6_FIXTURE_ORDER_PORT ?? 3104);

const fakeVerifier = {
  verify: async (token) => {
    if (!token.startsWith('test-token:')) throw new Error('invalid test token');
    const sub = token.slice('test-token:'.length);
    return { sub, email: `${sub}@load.invalid` };
  },
};

async function listen(app, port) {
  const server = app.listen(port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  servers.push(server);
}

async function loadQueue() {
  process.env.DB_NAME = 'queue';
  const service = await import('../services/queue/src/index.ts');
  service.__setVerifierForTests(fakeVerifier);
  pools.push(service.database);
  await listen(service.app, queuePort);
}

async function loadOrder() {
  process.env.DB_NAME = 'checkout';
  const service = await import('../services/order/src/index.ts');
  service.__setVerifierForTests(fakeVerifier);
  pools.push(service.database);
  await listen(service.app, orderPort);
}

const tier = ['checkout', 'mixed'].includes(mode) ? 'TIER1_GA' : 'TIER2_SEATED';
const capacity = mode === 'mixed' ? 300 : mode === 'queue' ? 200 : mode === 'checkout' ? 100 : 20;
const [eventResult] = await fixturePool.execute(
  `INSERT INTO event_inventory.events
     (organiser_sub, title, venue, starts_at, total_seats, available_buyers, tier, status)
   VALUES ('k6-ci', ?, 'Disposable CI', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY), ?, ?, ?, 'PUBLISHED')`,
  [`K6 ${mode} fixture`, capacity, tier === 'TIER2_SEATED' ? 20 : null, tier],
);
const eventId = Number(eventResult.insertId);
const [itemResult] = await fixturePool.execute(
  `INSERT INTO event_inventory.inventory_items (event_id, name, total_qty, price_cents)
   VALUES (?, 'K6 tickets', ?, 2500)`,
  [eventId, capacity],
);
const inventoryItemId = Number(itemResult.insertId);
const seatIds = [];
if (tier === 'TIER2_SEATED') {
  for (let index = 1; index <= capacity; index += 1) {
    const [seatResult] = await fixturePool.execute(
      `INSERT INTO event_inventory.seats
         (event_id, inventory_item_id, seat_label, row_label, seat_number)
       VALUES (?, ?, ?, 'A', ?)`,
      [eventId, inventoryItemId, `A${index}`, index],
    );
    seatIds.push(Number(seatResult.insertId));
  }
}

const [sessionResult] = await fixturePool.execute(
  `INSERT INTO \`queue\`.queue_sessions
     (event_id, opens_at, admission_batch_size, admission_interval_sec, status)
   VALUES (?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE), 20, 1, 'OPEN')`,
  [eventId],
);

// The production checkout contract requires every direct order to carry a
// live admission token. Seed one for each deterministic checkout VU identity
// so this isolated test measures order/payment contention rather than queueing.
if (mode === 'checkout' || mode === 'mixed') {
  const queueSessionId = Number(sessionResult.insertId);
  const customers = mode === 'mixed' ? Array.from({ length: 200 }, (_, index) => `mixed-${index}`) : [
    ...Array.from({ length: 50 }, (_, index) => `base-${index}`),
    ...Array.from({ length: 30 }, (_, index) => `probe-${index}`),
  ];
  for (const [index, customer] of customers.entries()) {
    await fixturePool.execute(
      `INSERT INTO \`queue\`.queue_entries
         (queue_session_id, customer_sub, position, status, admitted_at, admission_token, token_expires_at)
       VALUES (?, ?, ?, 'ADMITTED', UTC_TIMESTAMP(), ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE))`,
      [queueSessionId, customer, index + 1, `k6-admission-${customer}`],
    );
  }
  await fixturePool.execute(
    'UPDATE `queue`.queue_sessions SET next_position = ?, serving_position = ? WHERE queue_session_id = ?',
    [customers.length, customers.length, queueSessionId],
  );
}

if (mode === 'queue') await loadQueue();
if (mode === 'checkout') await loadOrder();
if (mode === 'journey' || mode === 'mixed') {
  await loadQueue();
  await loadOrder();
}

const environment = [
  `K6_EVENT_ID=${eventId}`,
  `K6_INVENTORY_ITEM_ID=${inventoryItemId}`,
  `K6_QUEUE_URL=http://127.0.0.1:${queuePort}`,
  `K6_ORDER_URL=http://127.0.0.1:${orderPort}`,
  `K6_SEAT_IDS=${seatIds.join(',')}`,
  `K6_EXPECTED_ORDERS=${mode === 'checkout' ? 80 : mode === 'mixed' ? 200 : mode === 'journey' ? 20 : 0}`,
  'K6_INTERNAL_TOKEN=k6-fixture-internal',
].join('\n') + '\n';
if (!process.env.K6_FIXTURE_ENV_FILE) throw new Error('K6_FIXTURE_ENV_FILE is required');
await writeFile(process.env.K6_FIXTURE_ENV_FILE, environment, { mode: 0o600 });
console.log(`Disposable ${mode} fixture ready for event ${eventId}.`);

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`Stopping disposable ${mode} fixture (${signal}).`);
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all([...new Set(pools)].map((pool) => pool.end()));
  await fixturePool.end();
  process.exit(0);
}

process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
