import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrations = [
  '02-init-create-tables-index.sql',
  '06-add-notification-schema.sql',
  '08-ticket-checkin-attempts.sql',
  '09-add-customer-name.sql',
  '15-email-notifications-per-ticket.sql',
  '11-add-inventory-layout.sql',
  '12-add-event-image-and-seat-tags.sql',
  '13-add-inventory-grid-position.sql',
  '14-add-grid-customization.sql',
  '16-add-event-cancellation-notification-type.sql',
  '17-add-event-team-soft-revoke.sql',
];

const host = process.env.DB_HOST;
const port = Number(process.env.DB_PORT);
const user = process.env.DB_USER;
const password = process.env.DB_PASSWORD;

if (host !== '127.0.0.1' || port !== 3307 || !user || !password) {
  throw new Error('Refusing to initialize a database outside the local test endpoint');
}

const connection = await mysql.createConnection({ host, port, user, password, multipleStatements: true });

try {
  for (const migration of migrations) {
    const sql = await readFile(path.join(repositoryRoot, 'database', migration), 'utf8');
    await connection.query(sql);
    console.log(`Applied ${migration}`);
  }
} finally {
  await connection.end();
}