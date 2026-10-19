import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { localMigrations } from './local-migrations.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const host = process.env.DB_HOST;
const port = Number(process.env.DB_PORT);
const user = process.env.DB_USER;
const password = process.env.DB_PASSWORD;

if (host !== '127.0.0.1' || port !== 3307 || !user || !password) {
  throw new Error('Refusing to initialize a database outside the local test endpoint');
}

const connection = await mysql.createConnection({ host, port, user, password, multipleStatements: true });

try {
  for (const migration of localMigrations) {
    const sql = await readFile(path.join(repositoryRoot, 'database', migration), 'utf8');
    await connection.query(sql);
    console.log(`Applied ${migration}`);
  }
} finally {
  await connection.end();
}
