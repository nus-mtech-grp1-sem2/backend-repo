import { readFile } from 'node:fs/promises';

import mysql from 'mysql2/promise';

const connection = await mysql.createConnection({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? '',
  multipleStatements: true,
});

try {
  const schema = await readFile(new URL('../k6/fixtures/inventory-schema.sql', import.meta.url), 'utf8');
  await connection.query(schema);
  console.log('Disposable k6 inventory schema initialized.');
} finally {
  await connection.end();
}
