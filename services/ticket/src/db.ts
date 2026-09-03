import mysql from 'mysql2/promise';

/**
 * Connection pool to the `ticketing` schema.
 *
 * The defaults point at the local `mysql` compose service (see
 * `infrastructure/docker-compose.yml`), so a plain `npm run dev` / `docker
 * compose up` needs no `.env` at all. In AWS these all come from real
 * environment variables (RDS endpoint, credentials) — same variable names as
 * the root `.env.example`, so nothing in this file changes between the two.
 *
 * This pool's user also holds grants on `onestagedb` (see
 * `infrastructure/sql/03-grant-schema-access.sql`), so this service can read
 * event/seat details directly by fully-qualified table name — see the
 * comment at the top of `infrastructure/sql/02-create-all-tables.sql` for why
 * that's acceptable while everything runs on one shared instance.
 */
export const pool = mysql.createPool({
  host: process.env.DB_HOST ?? 'mysql',
  port: Number(process.env.DB_PORT ?? 3306),
  database: process.env.DB_NAME ?? 'ticketing',
  user: process.env.DB_USER ?? 'onestage',
  password: process.env.DB_PASSWORD ?? 'onestage123',
  charset: 'utf8mb4_unicode_ci',
  waitForConnections: true,
  connectionLimit: 10,
});
