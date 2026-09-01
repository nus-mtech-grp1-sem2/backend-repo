import express from 'express';
import mysql from 'mysql2/promise';

const SERVICE = 'event';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3001);

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: SERVICE });
});

const databaseConfigured = Boolean(
  process.env.DB_HOST &&
  process.env.DB_NAME &&
  process.env.DB_USER &&
  process.env.DB_PASSWORD,
);

const database = mysql.createPool({
  host: process.env.DB_HOST ?? '',
  port: Number(process.env.DB_PORT ?? 3306),
  database: process.env.DB_NAME ?? '',
  user: process.env.DB_USER ?? '',
  password: process.env.DB_PASSWORD ?? '',
  connectionLimit: 4,
  ...(process.env.DB_SSL === 'false'
    ? {}
    : { ssl: { rejectUnauthorized: false } }),
});

/**
 * Published events list, newest start date first.
 *
 * Also mounted at /helper/shifts: Event Helper accounts get the same
 * read-only events view as Admin for now (their "New Event" action is
 * disabled client-side) — a dedicated shifts model doesn't exist yet.
 */
async function listEvents(_req: express.Request, res: express.Response) {
  if (!databaseConfigured) {
    res.status(503).json({ error: 'database_not_configured' });
    return;
  }

  try {
    const [rows] = await database.query(
      "SELECT event_id, event_name, event_type, event_start_datetime, event_end_datetime, status " +
        "FROM events WHERE status = 'published' ORDER BY event_start_datetime ASC",
    );
    res.json({ events: rows });
  } catch (error) {
    console.error('failed to list events', error);
    res.status(502).json({ error: 'events_list_failed' });
  }
}

app.get('/events', listEvents);
app.get('/helper/shifts', listEvents);

app.listen(PORT, HOST, () => {
  console.log(`${SERVICE}-service -> http://${HOST}:${PORT}`);
});
