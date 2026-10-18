import { randomBytes } from 'node:crypto';

import express from 'express';
import mysql from 'mysql2/promise';
import { withTransaction } from '../../shared/src/transaction.js';
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
let verifier = USER_POOL_ID && CLIENT_ID
  ? CognitoJwtVerifier.create({ userPoolId: USER_POOL_ID, clientId: CLIENT_ID, tokenUse: 'access' })
  : null;

export function __setVerifierForTests(fake: typeof verifier): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('test verifier can only be set in test mode');
  verifier = fake;
}
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

/**
 * Events carry a start time but no end time, so one that has started is
 * completed: nobody can queue for it or be admitted to buy. `has_started` is
 * computed by MySQL against UTC_TIMESTAMP(), the same reading of the stored
 * start time that the event API and the web app use.
 */
function eventHasStarted(event: Readonly<Record<string, unknown>> | undefined): boolean {
  return Number(event?.has_started) === 1;
}

/** Admission is only possible while an event is published and has not started. */
function assertEventOnSale<T extends Readonly<Record<string, unknown>>>(
  event: T | undefined,
): asserts event is T {
  if (event?.status !== 'PUBLISHED') throw new QueueApiError(409, 'event_not_on_sale');
  if (eventHasStarted(event)) throw new QueueApiError(409, 'event_completed');
}

/** A published event's queue is open automatically; only a drained queue stays closed. */
async function joinBlockReason(
  connection: mysql.PoolConnection,
  session: mysql.RowDataPacket,
): Promise<'queue_drained' | 'queue_not_open' | null> {
  if (session.status === 'CLOSED') {
    await connection.execute("UPDATE queue_sessions SET status = 'OPEN' WHERE queue_session_id = ?", [session.queue_session_id]);
    session.status = 'OPEN';
  }
  if (session.status === 'OPEN') return null;
  return session.status === 'DRAINED' ? 'queue_drained' : 'queue_not_open';
}

/**
 * A customer who is waiting, admitted or in checkout keeps their place when they
 * join again, unless their admission token has expired.
 */
function keepsQueuePlace(entry: QueueEntryRow): boolean {
  const tokenExpired =
    ['ADMITTED', 'IN_CHECKOUT'].includes(entry.status) &&
    entry.token_expires_at &&
    new Date(entry.token_expires_at).getTime() <= Date.now();
  return !tokenExpired && ['WAITING', 'ADMITTED', 'IN_CHECKOUT'].includes(entry.status);
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
  // The submitted batch size is retained for backwards-compatible request
  // validation, but the server derives the effective limit from the event's
  // capacity/available_buyers. Large GA events can legitimately exceed 10,000.
  if (!opensAtValue || Number.isNaN(opensAt.getTime()) || !admissionBatchSize ||
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
    `UPDATE queue_sessions s
     INNER JOIN event_inventory.events ev ON ev.event_id = s.event_id
     SET s.status = CASE
       WHEN ev.status = 'PUBLISHED' AND ev.starts_at > UTC_TIMESTAMP() THEN 'OPEN'
       ELSE 'CLOSED'
     END
     WHERE s.event_id = ? AND s.status IN ('OPEN', 'CLOSED')`,
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
    'SELECT tier, status, total_seats, available_buyers FROM event_inventory.events WHERE event_id = ? LIMIT 1', [eventId],
  );
  if (!events[0])
    return res.status(404).json({ error: 'event_not_found' });

  const status = events[0].status === 'PUBLISHED' && input.opensAt.getTime() <= Date.now()
    ? 'OPEN'
    : 'CLOSED';
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
  try {
    const result = await withTransaction(database, async (connection) => {
      // Acquire the mutex before the first consistent read. This keeps the
      // buyer lookup fresh even after waiting under MySQL REPEATABLE READ.
      const [sessions] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT queue_session_id, opens_at, status, next_position, serving_position FROM queue_sessions WHERE event_id = ? LIMIT 1 FOR UPDATE', [eventId],
      );
      const [events] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT status, total_seats, available_buyers, starts_at < UTC_TIMESTAMP() AS has_started FROM event_inventory.events WHERE event_id = ? LIMIT 1', [eventId],
      );
      assertEventOnSale(events[0]);
      let session = sessions[0];
      if (!session) {
        const [created] = await connection.execute<mysql.ResultSetHeader>(
          `INSERT INTO queue_sessions (event_id, opens_at, admission_batch_size, admission_interval_sec, status)
           VALUES (?, CURRENT_TIMESTAMP, ?, 60, 'OPEN')
           ON DUPLICATE KEY UPDATE queue_session_id = LAST_INSERT_ID(queue_session_id)`,
          [
            eventId,
            buyerCapacity(
              Number(events[0].total_seats),
              events[0].available_buyers === null ? null : Number(events[0].available_buyers),
            ),
          ],
        );
        const [createdSessions] = await connection.query<mysql.RowDataPacket[]>(
          'SELECT queue_session_id, opens_at, status, next_position, serving_position FROM queue_sessions WHERE queue_session_id = ? LIMIT 1 FOR UPDATE',
          [created.insertId],
        );
        session = createdSessions[0];
        if (!session) throw new Error('queue_session_create_failed');
      }
      const notJoinable = await joinBlockReason(connection, session);
      if (notJoinable) throw new QueueApiError(409, notJoinable);
      const [existingRows] = await connection.query<QueueEntryRow[]>(
        'SELECT queue_entry_id, position, status, admission_token, token_expires_at FROM queue_entries WHERE queue_session_id = ? AND customer_sub = ? LIMIT 1',
        [session.queue_session_id, caller.sub],
      );
      let entry = existingRows[0];
      if (entry) {
        // Never lock a secondary-index scan and then wait for its primary row:
        // checkout updates acquire the primary row first.
        const [current] = await connection.query<QueueEntryRow[]>(
          'SELECT queue_entry_id, position, status, admission_token, token_expires_at FROM queue_entries WHERE queue_entry_id = ? LIMIT 1 FOR UPDATE',
          [entry.queue_entry_id],
        );
        entry = current[0];
      }
      if (entry && keepsQueuePlace(entry)) {
        return { status: 200, body: queueEntryResponse(entry, Math.max(1, Number(entry.position) - Number(session.serving_position))) };
      }
      // next_position is the last allocated ticket. The session lock serializes
      // allocation without reading or locking anybody else's queue entry.
      const position = Number(session.next_position) + 1;
      if (!Number.isSafeInteger(position) || position <= 0) throw new Error('invalid_queue_counter');
      await connection.execute(
        'UPDATE queue_sessions SET next_position = next_position + 1 WHERE queue_session_id = ?',
        [session.queue_session_id],
      );
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
      return { status: 201, body: queueEntryResponse(entry, Math.max(1, position - Number(session.serving_position))) };
    });
    return res.status(result.status).json(result.body);
  } catch (error) {
    if (error instanceof QueueApiError) return res.status(error.status).json({ error: error.code });
    console.error('queue join failed', error);
    return res.status(502).json({ error: 'queue_join_failed' });
  }
});

async function findBuyerEntry(eventId: number, customerSub: string) {
  const [sessions] = await database.query<mysql.RowDataPacket[]>(
    'SELECT queue_session_id, serving_position FROM queue_sessions WHERE event_id = ? LIMIT 1', [eventId],
  );
  const session = sessions[0];
  if (!session) return null;
  const [entries] = await database.query<QueueEntryRow[]>(
    'SELECT queue_entry_id, position, status, admission_token, token_expires_at FROM queue_entries WHERE queue_session_id = ? AND customer_sub = ? LIMIT 1',
    [session.queue_session_id, customerSub],
  );
  return entries[0] ? { entry: entries[0], servingPosition: Number(session.serving_position) } : null;
}

app.get('/events/:eventId/queue/me', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!requireDatabase(res)) return;
  const eventId = positiveInteger(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  const buyer = await findBuyerEntry(eventId, caller.sub);
  if (!buyer) return res.status(404).json({ error: 'queue_entry_not_found' });
  const entry = await withTransaction(database, async (connection) => {
    await connection.execute(
      `UPDATE queue_entries SET status = 'EXPIRED', admission_token = NULL
       WHERE queue_entry_id = ? AND status IN ('ADMITTED', 'IN_CHECKOUT')
         AND token_expires_at <= CURRENT_TIMESTAMP`, [buyer.entry.queue_entry_id],
    );
    const [rows] = await connection.query<QueueEntryRow[]>(
      'SELECT queue_entry_id, position, status, admission_token, token_expires_at FROM queue_entries WHERE queue_entry_id = ? LIMIT 1',
      [buyer.entry.queue_entry_id],
    );
    return rows[0];
  });
  if (!entry) return res.status(404).json({ error: 'queue_entry_not_found' });
  // Retain the one-based position contract. This is an upper-bound estimate:
  // abandoned tickets ahead still count, without a per-poll COUNT(*) scan.
  const livePosition = Math.max(1, Number(entry.position) - buyer.servingPosition);
  return res.json(queueEntryResponse(entry, livePosition));
});

app.delete('/events/:eventId/queue/me', async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  const eventId = positiveInteger(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  if (!requireDatabase(res)) return;
  try {
    const buyer = await findBuyerEntry(eventId, caller.sub);
    if (!buyer) return res.status(404).json({ error: 'queue_entry_not_found' });
    const releasedBuyerSlot = await withTransaction(database, async (connection) => {
      const [rows] = await connection.query<QueueEntryRow[]>(
        'SELECT queue_entry_id, position, status, admission_token, token_expires_at FROM queue_entries WHERE queue_entry_id = ? LIMIT 1 FOR UPDATE',
        [buyer.entry.queue_entry_id],
      );
      const entry = rows[0];
      if (!entry) {
        throw new QueueApiError(404, 'queue_entry_not_found');
      }
      if (entry.status === 'IN_CHECKOUT') {
        throw new QueueApiError(409, 'queue_checkout_started');
      }
      if (entry.status !== 'LEFT' && entry.status !== 'EXPIRED') {
        await connection.execute(
          "UPDATE queue_entries SET status = 'LEFT', admission_token = NULL, token_expires_at = NULL WHERE queue_entry_id = ?",
          [entry.queue_entry_id],
        );
      }
      return entry.status === 'ADMITTED';
    });
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
    if (error instanceof QueueApiError) return res.status(error.status).json({ error: error.code });
    console.error('leave queue failed', error);
    return res.status(502).json({ error: 'queue_leave_failed' });
  }
});

/** Discover without range locks, then recheck each candidate through its PK.
 * Bounded batches keep sweep transactions small even after a long outage. */
async function expireAdmissions(connection: mysql.PoolConnection, sessionId?: number): Promise<void> {
  const [entries] = sessionId === undefined
    ? await connection.query<mysql.RowDataPacket[]>(
        `SELECT queue_entry_id FROM queue_entries
         WHERE status IN ('ADMITTED', 'IN_CHECKOUT') AND token_expires_at <= CURRENT_TIMESTAMP
         ORDER BY queue_entry_id LIMIT 200`,
      )
    : await connection.query<mysql.RowDataPacket[]>(
        `SELECT queue_entry_id FROM queue_entries WHERE queue_session_id = ?
         AND status IN ('ADMITTED', 'IN_CHECKOUT') AND token_expires_at <= CURRENT_TIMESTAMP
         ORDER BY queue_entry_id LIMIT 200`, [sessionId],
      );
  for (const entry of entries) {
    await connection.execute(
      `UPDATE queue_entries SET status = 'EXPIRED', admission_token = NULL
       WHERE queue_entry_id = ? AND status IN ('ADMITTED', 'IN_CHECKOUT')
         AND token_expires_at <= CURRENT_TIMESTAMP`, [entry.queue_entry_id],
    );
  }
}

async function admitNextBatch(eventId: number, bypassInterval = false): Promise<AdmissionResult> {
  const result = await withTransaction(database, async (connection): Promise<AdmissionResult & { events: CustomerAdmittedEvent[] }> => {
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
        e.starts_at < UTC_TIMESTAMP() AS has_started,
        CASE WHEN e.tier = 'TIER2_SEATED'
          THEN (SELECT COUNT(*) FROM event_inventory.seats WHERE event_id = e.event_id AND status = 'AVAILABLE')
          ELSE (SELECT COALESCE(SUM(total_qty - reserved_qty - sold_qty), 0) FROM event_inventory.inventory_items WHERE event_id = e.event_id)
        END AS available_qty
       FROM event_inventory.events e WHERE e.event_id = ? LIMIT 1`, [eventId],
    );
    const event = availabilityRows[0];
    assertEventOnSale(event);
    const availableTickets = Number(event.available_qty ?? 0);
    if (availableTickets <= 0) {
      await connection.execute("UPDATE queue_sessions SET status = 'DRAINED' WHERE queue_session_id = ?", [session.queue_session_id]);
      return { admitted: 0, remaining: null, reason: 'sold_out', events: [] };
    }
    await expireAdmissions(connection, Number(session.queue_session_id));
    // Cleanup is bounded, but admission capacity must ignore every expired
    // token, including rows that have not reached the cleanup batch yet.
    const [counts] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT SUM(status IN ('ADMITTED', 'IN_CHECKOUT') AND token_expires_at > CURRENT_TIMESTAMP) AS active_buyers,
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
      return { admitted: 0, remaining: remainingBeforeAdmission, reason: 'capacity_reached', events: [] };
    }
    const [waiting] = await connection.query<WaitingEntryRow[]>(
      `SELECT queue_entry_id, customer_sub, position, status, admission_token, token_expires_at FROM queue_entries
       WHERE queue_session_id = ? AND status = 'WAITING' ORDER BY position, queue_entry_id LIMIT ?`,
      [session.queue_session_id, limit],
    );
    const admittedEvents: CustomerAdmittedEvent[] = [];
    let servingPosition = 0;
    // Acquire primary rows in a stable order; the session mutex already
    // serializes admission and joins, so no locking secondary scan is needed.
    for (const entry of [...waiting].sort((a, b) => Number(a.queue_entry_id) - Number(b.queue_entry_id))) {
      const admittedAt = new Date();
      const tokenExpiresAt = new Date(admittedAt.getTime() + TOKEN_TTL_SEC * 1_000);
      const [updated] = await connection.execute<mysql.ResultSetHeader>(
        `UPDATE queue_entries SET status = 'ADMITTED', admitted_at = ?, admission_token = ?,
          token_expires_at = ? WHERE queue_entry_id = ? AND status = 'WAITING'`,
        [admittedAt, randomBytes(32).toString('base64url'), tokenExpiresAt, entry.queue_entry_id],
      );
      if (updated.affectedRows !== 1) continue; // A concurrent leave won the row.
      servingPosition = Math.max(servingPosition, Number(entry.position));
      admittedEvents.push(customerAdmittedEvent({
        queueEntryId: Number(entry.queue_entry_id), eventId, customerSub: entry.customer_sub,
        occurredAt: admittedAt, tokenExpiresAt,
      }));
    }
    if (servingPosition > 0) {
      await connection.execute(
        'UPDATE queue_sessions SET serving_position = GREATEST(serving_position, ?) WHERE queue_session_id = ?',
        [servingPosition, session.queue_session_id],
      );
    }
    const [remainingRows] = await connection.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS remaining FROM queue_entries WHERE queue_session_id = ? AND status = 'WAITING'", [session.queue_session_id],
    );
    const remaining = Number(remainingRows[0]?.remaining ?? 0);
    return { admitted: admittedEvents.length, remaining, events: admittedEvents };
  });
  // Do not hold a pooled connection while talking to SQS. A publication error
  // cannot roll back or replay an already committed admission batch.
  const { events: admittedEvents, ...summary } = result;
  if (admittedEvents.length === 0) {
    return summary.reason ? summary : { ...summary, eventsPublished: 0, eventPublication: 'not_required' };
  }
  let eventPublication: 'published' | 'disabled' | 'failed' = CUSTOMER_ADMITTED_QUEUE_URL ? 'published' : 'disabled';
  let eventsPublished = 0;
  try {
    eventsPublished = await publishCustomerAdmitted(admittedEvents);
  } catch (error) {
    eventPublication = 'failed';
    console.error('customer admitted event publication failed', error);
  }
  return { ...summary, eventsPublished, eventPublication };
}

async function runAdmissionSweep(now = Date.now()): Promise<number> {
  if (!databaseConfigured || !AUTO_ADMISSION_ENABLED) return 0;
  await withTransaction(database, (connection) => expireAdmissions(connection));
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
    // Internal callers use this endpoint when an active buyer releases a slot,
    // so refill immediately instead of waiting for the normal admission cadence.
    return res.json(await admitNextBatch(eventId, internalRequest));
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
  assertEventOnSale,
  customerAdmittedEvent,
  eventHasStarted,
  keepsQueuePlace,
  parseConfig,
  positiveInteger,
  publishCustomerAdmitted,
  runAdmissionSweep,
  database,
};
