import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

const loaded = dotenv.config({ path: 'variables.env' });
if (loaded.error) {
  console.error('Database configuration file variables.env was not found.');
  process.exitCode = 1;
} else {
  const required = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD'];
  const missing = required.filter((key) => !process.env[key]);
  if (!process.env.DB_NAME && !process.env.DB_NAME_TICKETING) missing.push('DB_NAME_TICKETING');
  if (missing.length > 0) {
    console.error(`Database configuration is missing: ${missing.join(', ')}`);
    process.exitCode = 1;
  } else {
    const pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: process.env.DB_NAME ?? process.env.DB_NAME_TICKETING,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      waitForConnections: true,
      connectionLimit: Number(process.env.DB_CONNECTION_LIMIT ?? 10),
      connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT ?? 10000),
      enableKeepAlive: true,
      ...(process.env.DB_SSL === 'false' ? {} : { ssl: { rejectUnauthorized: false } }),
    });

    try {
      await pool.query('SELECT 1');
      console.log('Database connection OK.');
    } catch {
      console.error('Database connection failed.');
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }
}