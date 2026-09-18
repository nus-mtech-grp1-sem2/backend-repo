import { randomBytes } from 'node:crypto';

import express from 'express';
import mysql from 'mysql2/promise';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import {
  SendMessageBatchCommand,
  SQSClient,
  type SendMessageBatchCommandInput,
} from '@aws-sdk/client-sqs';

const SERVICE = 'queue';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3003);
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN ?? '';
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? '';
const CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? '';
const CUSTOMER_ADMITTED_QUEUE_URL = process.env.CUSTOMER_ADMITTED_QUEUE_URL ?? '';
const verifier = USER_POOL_ID && CLIENT_ID
  ? CognitoJwtVerifier.create({ userPoolId: USER_POOL_ID, clientId: CLIENT_ID, tokenUse: 'access' })
  : null;
const sqs = new SQSClient({});

const databaseConfigured = Boolean(
  process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER && process.env.DB_PASSWORD,
);
const database = mysql.createPool({
  host: process.env.DB_HOST ?? '',
  port: Number(process.env.DB_PORT ?? 3306),
  database: process.env.DB_NAME ?? '',
  user: process.env.DB_USER ?? '',
  password: process.env.DB_PASSWORD ?? '',
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT ?? 8),
  connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT ?? 10_000),
  ...(process.env.DB_SSL === 'false' ? {} : { ssl: { rejectUnauthorized: false } }),
});

interface Caller { readonly sub: string }
interface QueueConfigInput {
  readonly opensAt?: unknown;
  readonly admissionBatchSize?: unknown;
  readonly admissionIntervalSec?: unknown;
}
interface QueueEntryRow extends mysql.RowDataPacket {
  readonly queue_entry_id: number;
  readonly position: number;
  readonly status: 'WAITING' | 'ADMITTED' | 'IN_CHECKOUT' | 'EXPIRED' | 'LEFT';
  readonly admission_token: string | null;
  readonly token_expires_at: Date | null;
}
interface WaitingEntryRow extends QueueEntryRow { readonly customer_sub: string }
interface CustomerAdmittedEvent {
  readonly type: 'CustomerAdmitted';
  readonly version: 1;
  readonly occurredAt: string;
  readonly queueEntryId: number;
  readonly eventId: number;
  readonly customerSub: string;
  readonly tokenExpiresAt: string;
}
interface BatchSendResult {
  readonly Failed?: readonly {
    readonly Id?: string | undefined;
    readonly Code?: string | undefined;
  }[] | undefined;
}
type BatchSender = (input: SendMessageBatchCommandInput) => Promise<BatchSendResult>;
interface AdmissionResult {
  readonly admitted: number;
  readonly remaining: number | null;
  readonly reason?: 'sold_out' | 'capacity_reached';
  readonly eventsPublished?: number;
  readonly eventPublication?: 'published' | 'disabled' | 'failed' | 'not_required';
}

class QueueApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.get('/health', (_req, res) => res.json({ status: 'ok', service: SERVICE }));

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

const TOKEN_TTL_SEC = positiveInteger(process.env.ADMISSION_TOKEN_TTL_SEC) ?? 600;
const AUTO_ADMISSION_ENABLED = process.env.AUTO_ADMISSION_ENABLED !== 'false';
const ADMISSION_SCHEDULER_POLL_MS = Math.min(
  positiveInteger(process.env.ADMISSION_SCHEDULER_POLL_MS) ?? 1_000,
  60_000,
);

function admissionDue(lastAdmittedAt: Date | string | null, intervalSec: number, now = Date.now()): boolean {
  if (!lastAdmittedAt) return true;
  return new Date(lastAdmittedAt).getTime() + intervalSec * 1_000 <= now;
}

function admissionAllowed(
  lastAdmittedAt: Date | string | null,
  intervalSec: number,
  bypassInterval: boolean,
  now = Date.now(),
): boolean {
  return bypassInterval || admissionDue(lastAdmittedAt, intervalSec, now);
}

function admissionBatchSize(totalTickets: number): number {
  if (!Number.isFinite(totalTickets) || totalTickets <= 0) return 0;
  return Math.max(1, Math.ceil(totalTickets * 0.1));
}

function buyerCapacity(totalTickets: number, configuredBuyers: number | null): number {
  if (configuredBuyers !== null && Number.isSafeInteger(configuredBuyers) && configuredBuyers > 0) {
    return Math.min(configuredBuyers, Math.max(0, Math.floor(totalTickets)));
  }
  return admissionBatchSize(totalTickets);
}

function availableAdmissionSlots(totalTickets: number, configuredBuyers: number | null, activeBuyers: number, availableTickets: number): number {
  return Math.max(0, Math.min(
    buyerCapacity(totalTickets, configuredBuyers) - Math.max(0, Math.floor(activeBuyers)),
    Math.max(0, Math.floor(availableTickets)),
  ));
}

function customerAdmittedEvent(input: {
  queueEntryId: number;
  eventId: number;
  customerSub: string;
  occurredAt: Date;
  tokenExpiresAt: Date;
}): CustomerAdmittedEvent {
  return {
    type: 'CustomerAdmitted',
    version: 1,
    occurredAt: input.occurredAt.toISOString(),
    queueEntryId: input.queueEntryId,
    eventId: input.eventId,
    customerSub: input.customerSub,
    tokenExpiresAt: input.tokenExpiresAt.toISOString(),
  };
}

const sendCustomerAdmittedBatch: BatchSender = async (input) =>
  sqs.send(new SendMessageBatchCommand(input));

async function publishCustomerAdmitted(
  events: readonly CustomerAdmittedEvent[],
  queueUrl = CUSTOMER_ADMITTED_QUEUE_URL,
  sendBatch: BatchSender = sendCustomerAdmittedBatch,
): Promise<number> {
  if (!queueUrl || events.length === 0) return 0;
  let published = 0;
  for (let offset = 0; offset < events.length; offset += 10) {
    const batch = events.slice(offset, offset + 10);
    let pending = batch.map((event, index) => ({
      Id: `${event.queueEntryId}-${offset + index}`,
      MessageBody: JSON.stringify(event),
      MessageAttributes: {
        EventType: { DataType: 'String', StringValue: event.type },
        EventId: { DataType: 'Number', StringValue: String(event.eventId) },
      },
    }));
    for (let attempt = 1; attempt <= 3 && pending.length > 0; attempt += 1) {
      const result = await sendBatch({ QueueUrl: queueUrl, Entries: pending });
      if (result.Failed?.some((failure) => !failure.Id)) {
        throw new Error('customer_admitted_batch_failed:unknown');
      }
      const failedIds = new Set(result.Failed?.map((failure) => failure.Id as string) ?? []);
      published += pending.filter((entry) => !failedIds.has(entry.Id)).length;
      pending = pending.filter((entry) => failedIds.has(entry.Id));
      if (attempt === 3 && pending.length > 0) {
        throw new Error(`customer_admitted_batch_failed:${pending.map((entry) => entry.Id).join(',')}`);
      }
    }
  }
  return published;
}

function parseConfig(input: QueueConfigInput): {
  opensAt: Date;
  admissionBatchSize: number;
  admissionIntervalSec: number;
} | null {
  const opensAtValue = typeof input.opensAt === 'string' ? input.opensAt.trim() : '';
  const opensAt = new Date(opensAtValue);
  const admissionBatchSize = positiveInteger(input.admissionBatchSize);
  const admissionIntervalSec = positiveInteger(input.admissionIntervalSec);
  if (!opensAtValue || Number.isNaN(opensAt.getTime()) || !admissionBatchSize || admissionBatchSize > 10_000 ||
      !admissionIntervalSec || admissionIntervalSec > 86_400) return null;
  return { opensAt, admissionBatchSize, admissionIntervalSec };
}

async function authenticate(req: express.Request): Promise<Caller | null> {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !verifier) return null;
  try {
    const claims = await verifier.verify(token);
    return { sub: String(claims.sub) };
  } catch {
    return null;
  }
}

async function requireCaller(req: express.Request, res: express.Response): Promise<Caller | null> {
  const caller = await authenticate(req);
  if (!caller) res.status(401).json({ error: 'unauthenticated' });
  return caller;
}

function requireDatabase(res: express.Response): boolean {
  if (!databaseConfigured) res.status(503).json({ error: 'database_not_configured' });
  return databaseConfigured;
}

async function hasEventRole(eventId: number, sub: string, roles: readonly string[]): Promise<boolean> {
  const placeholders = roles.map(() => '?').join(', ');
  const [rows] = await database.query<mysql.RowDataPacket[]>(
    `SELECT membership_id FROM event_inventory.event_team_memberships
     WHERE event_id = ? AND user_sub = ? AND role IN (${placeholders}) AND invite_status = 'ACCEPTED' LIMIT 1`,
    [eventId, sub, ...roles],
  );
  return rows.length > 0;
}

function queueEntryResponse(entry: QueueEntryRow, livePosition?: number) {
  return {
    queueEntryId: Number(entry.queue_entry_id),
    status: entry.status,
    ...(entry.status === 'WAITING' ? { position: livePosition ?? Number(entry.position) } : {}),
    ...(entry.status === 'ADMITTED' ? {
      admissionToken: entry.admission_token ?? undefined,
      tokenExpiresAt: entry.token_expires_at ?? undefined,
    } : {}),
  };
}

app.get('/events/:eventId/queue', async (req, res) => {
  const eventId = positiveInteger(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  if (!requireDatabase(res)) return;
  await database.execute(
    "UPDATE queue_sessions SET status = 'OPEN' WHERE event_id = ? AND status = 'CLOSED' AND opens_at <= CURRENT_TIMESTAMP",
    [eventId],
  );
  const [sessions] = await database.query<mysql.RowDataPacket[]>(
    `SELECT s.queue_session_id, s.event_id, s.opens_at, ev.total_seats, ev.available_buyers,
      s.admission_interval_sec, s.status,
      SUM(CASE WHEN e.status = 'WAITING' THEN 1 ELSE 0 END) AS waiting_count
     FROM queue_sessions s
     INNER JOIN event_inventory.events ev ON ev.event_id = s.event_id
     LEFT JOIN queue_entries e ON e.queue_session_id = s.queue_session_id
     WHERE s.event_id = ?
     GROUP BY s.queue_session_id, s.event_id, s.opens_at, ev.total_seats, ev.available_buyers,
       s.admission_interval_sec, s.status
     LIMIT 1`,
    [eventId],
  );
  const session = sessions[0];
  if (!session) return res.status(404).json({ error: 'queue_not_configured' });
  return res.json({
    queue: {
      eventId: Number(session.event_id),
      opensAt: session.opens_at,
      admissionBatchSize: buyerCapacity(
        Number(session.total_seats),
        session.available_buyers === null ? null : Number(session.available_buyers),
      ),
      admissionIntervalSec: Number(session.admission_interval_sec),
      status: session.status,
      waitingCount: Number(session.waiting_count ?? 0),
    },
  });
});

app.put('/events/:eventId/queue/config', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!requireDatabase(res)) return;
  const eventId = positiveInteger(req.params.eventId);
  const input = parseConfig(req.body as QueueConfigInput);
  if (!eventId || !input) 
    return res.status(400).json({ error: 'invalid_queue_config' });
  if (!(await hasEventRole(eventId, caller.sub, ['ORGANISER']))) {
    return res.status(403).json({ error: 'event_organiser_required' });
  }
  const [events] = await database.query<mysql.RowDataPacket[]>(
    'SELECT tier, total_seats, available_buyers FROM event_inventory.events WHERE event_id = ? LIMIT 1', [eventId],
  );
  if (!events[0]) 
    return res.status(404).json({ error: 'event_not_found' });
  if (events[0].tier !== 'TIER2_SEATED') 
    return res.status(409).json({ error: 'queue_only_supported_for_tier2' });

  const status = input.opensAt.getTime() <= Date.now() ? 'OPEN' : 'CLOSED';
  await database.execute(
    `INSERT INTO queue_sessions (event_id, opens_at, admission_batch_size, admission_interval_sec, status)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE opens_at = VALUES(opens_at), admission_batch_size = VALUES(admission_batch_size),
       admission_interval_sec = VALUES(admission_interval_sec), status = VALUES(status)`,
    [eventId, input.opensAt, buyerCapacity(
      Number(events[0].total_seats),
      events[0].available_buyers === null ? null : Number(events[0].available_buyers),
    ), input.admissionIntervalSec, status],
  );
  const [sessions] = await database.query<mysql.RowDataPacket[]>(
    'SELECT queue_session_id, event_id, opens_at, admission_batch_size, admission_interval_sec, status FROM queue_sessions WHERE event_id = ? LIMIT 1',
    [eventId],
  );
  return res.json({ queueSession: sessions[0] });
});

app.post('/events/:eventId/queue/join', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!requireDatabase(res)) return;
  const eventId = positiveInteger(req.params.eventId);
  if (!eventId) 
    return res.status(400).json({ error: 'invalid_event' });
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    const [sessions] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT queue_session_id, opens_at, status FROM queue_sessions WHERE event_id = ? LIMIT 1 FOR UPDATE', [eventId],
    );
    const session = sessions[0];
    if (!session) { await connection.rollback(); return res.status(404).json({ error: 'queue_not_configured' }); }
    if (session.status === 'CLOSED' && new Date(session.opens_at).getTime() <= Date.now()) {
      await connection.execute("UPDATE queue_sessions SET status = 'OPEN' WHERE queue_session_id = ?", [session.queue_session_id]);
      session.status = 'OPEN';
    }
    if (session.status !== 'OPEN') {
      await connection.rollback();
      return res.status(409).json({ error: session.status === 'DRAINED' ? 'queue_drained' : 'queue_not_open' });
    }
    const [existingRows] = await connection.query<QueueEntryRow[]>(
      'SELECT queue_entry_id, position, status, admission_token, token_expires_at FROM queue_entries WHERE queue_session_id = ? AND customer_sub = ? LIMIT 1 FOR UPDATE',
      [session.queue_session_id, caller.sub],
    );
    let entry = existingRows[0];
    const tokenExpired = entry && ['ADMITTED', 'IN_CHECKOUT'].includes(entry.status) &&
      entry.token_expires_at && new Date(entry.token_expires_at).getTime() <= Date.now();
    if (entry && !tokenExpired && ['WAITING', 'ADMITTED', 'IN_CHECKOUT'].includes(entry.status)) {
      await connection.commit();
      return res.json(queueEntryResponse(entry));
    }
    const [positions] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM queue_entries WHERE queue_session_id = ?',
      [session.queue_session_id],
    );
    const position = Number(positions[0]?.next_position ?? 1);
    if (entry) {
      await connection.execute(
        "UPDATE queue_entries SET position = ?, status = 'WAITING', joined_at = CURRENT_TIMESTAMP, admitted_at = NULL, admission_token = NULL, token_expires_at = NULL WHERE queue_entry_id = ?",
        [position, entry.queue_entry_id],
      );
      entry = { ...entry, position, status: 'WAITING', admission_token: null, token_expires_at: null };
    } else {
      const [insert] = await connection.execute<mysql.ResultSetHeader>(
        'INSERT INTO queue_entries (queue_session_id, customer_sub, position) VALUES (?, ?, ?)',
        [session.queue_session_id, caller.sub, position],
      );
      entry = { queue_entry_id: insert.insertId, position, status: 'WAITING', admission_token: null, token_expires_at: null } as QueueEntryRow;
    }
    await connection.commit();
    return res.status(201).json(queueEntryResponse(entry));
  } catch (error) {
    await connection.rollback();
    console.error('queue join failed', error);
    return res.status(502).json({ error: 'queue_join_failed' });
  } finally { connection.release(); }
});

app.get('/events/:eventId/queue/me', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!requireDatabase(res)) return;
  const eventId = positiveInteger(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  await database.execute(
    `UPDATE queue_entries e INNER JOIN queue_sessions s ON s.queue_session_id = e.queue_session_id
     SET e.status = 'EXPIRED', e.admission_token = NULL
     WHERE s.event_id = ? AND e.customer_sub = ? AND e.status IN ('ADMITTED', 'IN_CHECKOUT')
       AND e.token_expires_at <= CURRENT_TIMESTAMP`,
    [eventId, caller.sub],
  );
  const [rows] = await database.query<QueueEntryRow[]>(
    `SELECT e.queue_entry_id, e.position, e.status, e.admission_token, e.token_expires_at
     FROM queue_entries e INNER JOIN queue_sessions s ON s.queue_session_id = e.queue_session_id
     WHERE s.event_id = ? AND e.customer_sub = ? LIMIT 1`, [eventId, caller.sub],
  );
  const entry = rows[0];
  if (!entry) return res.status(404).json({ error: 'queue_entry_not_found' });
  let livePosition: number | undefined;
  if (entry.status === 'WAITING') {
    const [counts] = await database.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS live_position FROM queue_entries e INNER JOIN queue_sessions s ON s.queue_session_id = e.queue_session_id
       WHERE s.event_id = ? AND e.status = 'WAITING' AND e.position <= ?`, [eventId, entry.position],
    );
    livePosition = Number(counts[0]?.live_position ?? entry.position);
  }
  return res.json(queueEntryResponse(entry, livePosition));
});

app.delete('/events/:eventId/queue/me', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  const eventId = positiveInteger(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  if (!requireDatabase(res)) return;
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query<QueueEntryRow[]>(
      `SELECT e.queue_entry_id, e.position, e.status, e.admission_token, e.token_expires_at
       FROM queue_entries e INNER JOIN queue_sessions s ON s.queue_session_id = e.queue_session_id
       WHERE s.event_id = ? AND e.customer_sub = ? LIMIT 1 FOR UPDATE`,
      [eventId, caller.sub],
    );
    const entry = rows[0];
    if (!entry) {
      await connection.rollback();
      return res.status(404).json({ error: 'queue_entry_not_found' });
    }
    if (entry.status === 'IN_CHECKOUT') {
      await connection.rollback();
      return res.status(409).json({ error: 'queue_checkout_started' });
    }
    const releasedBuyerSlot = entry.status === 'ADMITTED';
    if (entry.status !== 'LEFT' && entry.status !== 'EXPIRED') {
      await connection.execute(
        "UPDATE queue_entries SET status = 'LEFT', admission_token = NULL, token_expires_at = NULL WHERE queue_entry_id = ?",
        [entry.queue_entry_id],
      );
    }
    await connection.commit();
    if (releasedBuyerSlot) {
      try {
        await admitNextBatch(eventId, true);
      } catch (error) {
        if (!(error instanceof QueueApiError && [404, 409].includes(error.status))) {
          console.error('failed to refill released queue slot', { eventId, error });
        }
      }
    }
    return res.status(204).end();
  } catch (error) {
    await connection.rollback();
    console.error('leave queue failed', error);
    return res.status(502).json({ error: 'queue_leave_failed' });
  } finally {
    connection.release();
  }
});

async function admitNextBatch(eventId: number, bypassInterval = false): Promise<AdmissionResult> {
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    const [sessions] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT queue_session_id, admission_interval_sec, status FROM queue_sessions WHERE event_id = ? LIMIT 1 FOR UPDATE', [eventId],
    );
    const session = sessions[0];
    if (!session) throw new QueueApiError(404, 'queue_not_configured');
    if (session.status !== 'OPEN') throw new QueueApiError(409, 'queue_not_open');
    const [recent] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT MAX(admitted_at) AS last_admitted_at FROM queue_entries WHERE queue_session_id = ?', [session.queue_session_id],
    );
    const lastAdmittedAt = recent[0]?.last_admitted_at ? new Date(recent[0].last_admitted_at).getTime() : 0;
    if (!admissionAllowed(
      lastAdmittedAt ? new Date(lastAdmittedAt) : null,
      Number(session.admission_interval_sec),
      bypassInterval,
    )) {
      throw new QueueApiError(429, 'admission_interval_not_elapsed');
    }
    const [availabilityRows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT e.status, e.tier, e.total_seats, e.available_buyers,
        CASE WHEN e.tier = 'TIER2_SEATED'
          THEN (SELECT COUNT(*) FROM event_inventory.seats WHERE event_id = e.event_id AND status = 'AVAILABLE')
          ELSE (SELECT COALESCE(SUM(total_qty - reserved_qty - sold_qty), 0) FROM event_inventory.inventory_items WHERE event_id = e.event_id)
        END AS available_qty
       FROM event_inventory.events e WHERE e.event_id = ? LIMIT 1`, [eventId],
    );
    const event = availabilityRows[0];
    if (!event || event.status !== 'PUBLISHED') throw new QueueApiError(409, 'event_not_on_sale');
    const availableTickets = Number(event.available_qty ?? 0);
    if (availableTickets <= 0) {
      await connection.execute("UPDATE queue_sessions SET status = 'DRAINED' WHERE queue_session_id = ?", [session.queue_session_id]);
      await connection.commit();
      return { admitted: 0, remaining: null, reason: 'sold_out' };
    }
    await connection.execute(
      `UPDATE queue_entries SET status = 'EXPIRED', admission_token = NULL
       WHERE queue_session_id = ? AND status IN ('ADMITTED', 'IN_CHECKOUT')
         AND token_expires_at <= CURRENT_TIMESTAMP`,
      [session.queue_session_id],
    );
    const [counts] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT SUM(status IN ('ADMITTED', 'IN_CHECKOUT')) AS active_buyers,
        SUM(status = 'WAITING') AS remaining
       FROM queue_entries WHERE queue_session_id = ?`,
      [session.queue_session_id],
    );
    const activeBuyers = Number(counts[0]?.active_buyers ?? 0);
    const remainingBeforeAdmission = Number(counts[0]?.remaining ?? 0);
    const limit = availableAdmissionSlots(
      Number(event.total_seats),
      event.available_buyers === null ? null : Number(event.available_buyers),
      activeBuyers,
      availableTickets,
    );
    if (limit <= 0) {
      await connection.commit();
      return { admitted: 0, remaining: remainingBeforeAdmission, reason: 'capacity_reached' };
    }
    const [waiting] = await connection.query<WaitingEntryRow[]>(
      `SELECT queue_entry_id, customer_sub, position, status, admission_token, token_expires_at FROM queue_entries
       WHERE queue_session_id = ? AND status = 'WAITING' ORDER BY position LIMIT ? FOR UPDATE`,
      [session.queue_session_id, limit],
    );
    const admittedEvents: CustomerAdmittedEvent[] = [];
    for (const entry of waiting) {
      const admittedAt = new Date();
      const tokenExpiresAt = new Date(admittedAt.getTime() + TOKEN_TTL_SEC * 1_000);
      await connection.execute(
        `UPDATE queue_entries SET status = 'ADMITTED', admitted_at = ?, admission_token = ?,
          token_expires_at = ? WHERE queue_entry_id = ?`,
        [admittedAt, randomBytes(32).toString('base64url'), tokenExpiresAt, entry.queue_entry_id],
      );
      admittedEvents.push(customerAdmittedEvent({
        queueEntryId: Number(entry.queue_entry_id), eventId, customerSub: entry.customer_sub,
        occurredAt: admittedAt, tokenExpiresAt,
      }));
    }
    const [remainingRows] = await connection.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS remaining FROM queue_entries WHERE queue_session_id = ? AND status = 'WAITING'", [session.queue_session_id],
    );
    const remaining = Number(remainingRows[0]?.remaining ?? 0);
    await connection.commit();
    let eventPublication: 'published' | 'disabled' | 'failed' | 'not_required' = admittedEvents.length === 0
      ? 'not_required'
      : CUSTOMER_ADMITTED_QUEUE_URL ? 'published' : 'disabled';
    let eventsPublished = 0;
    try {
      eventsPublished = await publishCustomerAdmitted(admittedEvents);
    } catch (error) {
      eventPublication = 'failed';
      console.error('customer admitted event publication failed', error);
    }
    return { admitted: waiting.length, remaining, eventsPublished, eventPublication };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

async function runAdmissionSweep(now = Date.now()): Promise<number> {
  if (!databaseConfigured || !AUTO_ADMISSION_ENABLED) return 0;
  await database.execute(
    `UPDATE queue_entries
     SET status = 'EXPIRED', admission_token = NULL
     WHERE status IN ('ADMITTED', 'IN_CHECKOUT') AND token_expires_at <= CURRENT_TIMESTAMP`,
  );
  const [sessions] = await database.query<mysql.RowDataPacket[]>(
    `SELECT s.event_id, s.admission_interval_sec, MAX(e.admitted_at) AS last_admitted_at
     FROM queue_sessions s
     LEFT JOIN queue_entries e ON e.queue_session_id = s.queue_session_id
     WHERE s.status = 'OPEN' AND s.opens_at <= CURRENT_TIMESTAMP
       AND EXISTS (
         SELECT 1 FROM queue_entries waiting
         WHERE waiting.queue_session_id = s.queue_session_id AND waiting.status = 'WAITING'
       )
     GROUP BY s.queue_session_id, s.event_id, s.admission_interval_sec`,
  );
  let admitted = 0;
  for (const session of sessions) {
    if (!admissionDue(session.last_admitted_at ?? null, Number(session.admission_interval_sec), now)) continue;
    try {
      admitted += (await admitNextBatch(Number(session.event_id))).admitted;
    } catch (error) {
      if (error instanceof QueueApiError && [409, 429].includes(error.status)) continue;
      console.error('automatic queue admission failed', { eventId: Number(session.event_id), error });
    }
  }
  return admitted;
}

let admissionSweepRunning = false;
function startAdmissionScheduler(): void {
  if (!databaseConfigured || !AUTO_ADMISSION_ENABLED) return;
  const tick = async () => {
    if (admissionSweepRunning) return;
    admissionSweepRunning = true;
    try {
      await runAdmissionSweep();
    } catch (error) {
      console.error('automatic admission sweep failed', error);
    } finally {
      admissionSweepRunning = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), ADMISSION_SCHEDULER_POLL_MS);
  timer.unref();
}

app.post('/events/:eventId/queue/admit-next', async (req, res) => {
  const eventId = positiveInteger(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  const internalRequest = Boolean(
    INTERNAL_API_TOKEN && req.header('x-internal-token') === INTERNAL_API_TOKEN,
  );
  let caller: Caller | null = null;
  if (!internalRequest) {
    caller = await requireCaller(req, res);
    if (!caller) return;
  }
  if (!requireDatabase(res)) return;
  if (caller && !(await hasEventRole(eventId, caller.sub, ['ORGANISER']))) {
    return res.status(403).json({ error: 'event_organiser_required' });
  }
  try {
    return res.json(await admitNextBatch(eventId));
  } catch (error) {
    if (error instanceof QueueApiError) return res.status(error.status).json({ error: error.code });
    console.error('queue admission failed', error);
    return res.status(502).json({ error: 'queue_admission_failed' });
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('unhandled queue error', error);
  if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, HOST, () => {
    console.log(`${SERVICE}-service -> http://${HOST}:${PORT}`);
    startAdmissionScheduler();
  });
}

export {
  admissionAllowed,
  admissionBatchSize,
  admissionDue,
  availableAdmissionSlots,
  app,
  buyerCapacity,
  customerAdmittedEvent,
  parseConfig,
  positiveInteger,
  publishCustomerAdmitted,
  runAdmissionSweep,
};
