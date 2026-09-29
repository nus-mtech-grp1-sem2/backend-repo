import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "./db.js";
import type { EmailNotificationRecord, NotificationStatus, NotificationType } from "./types.js";

interface EmailNotificationRow extends RowDataPacket {
  notification_id: number;
  order_id: number;
  ticket_id: number | null;
  event_id: number;
  customer_sub: string;
  customer_email: string;
  type: NotificationType;
  status: NotificationStatus;
  subject: string;
  error_message: string | null;
  sent_at: Date | null;
  created_at: Date;
}

function toRecord(row: EmailNotificationRow): EmailNotificationRecord {
  return {
    notificationId: row.notification_id,
    orderId: row.order_id,
    ticketId: row.ticket_id === null ? null : Number(row.ticket_id),
    eventId: row.event_id,
    customerSub: row.customer_sub,
    customerEmail: row.customer_email,
    type: row.type,
    status: row.status,
    subject: row.subject,
    errorMessage: row.error_message,
    sentAt: row.sent_at ? row.sent_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function findByTicketId(ticketId: number): Promise<EmailNotificationRecord | null> {
  const [rows] = await pool.query<EmailNotificationRow[]>(
    "SELECT * FROM email_notifications WHERE ticket_id = ?",
    [ticketId],
  );
  const row = rows[0];
  return row ? toRecord(row) : null;
}

/** Every email recorded for an order, one per ticket, oldest ticket first. */
export async function listByOrderId(orderId: number): Promise<EmailNotificationRecord[]> {
  const [rows] = await pool.query<EmailNotificationRow[]>(
    "SELECT * FROM email_notifications WHERE order_id = ? ORDER BY ticket_id, notification_id",
    [orderId],
  );
  return rows.map(toRecord);
}

export interface UpsertOutcomeInput {
  orderId: number;
  ticketId: number;
  eventId: number;
  customerSub: string;
  customerEmail: string;
  status: NotificationStatus;
  subject: string;
  errorMessage: string | null;
}

/** Records the outcome of one ticket's email. A repeat for the same ticket updates its row. */
export async function upsertOutcome(input: UpsertOutcomeInput): Promise<EmailNotificationRecord> {
  await pool.query(
    `INSERT INTO email_notifications
       (order_id, ticket_id, event_id, customer_sub, customer_email, type, status, subject, error_message, sent_at)
     VALUES (?, ?, ?, ?, ?, 'ORDER_CONFIRMATION', ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       status = VALUES(status),
       subject = VALUES(subject),
       error_message = VALUES(error_message),
       sent_at = VALUES(sent_at)`,
    [
      input.orderId,
      input.ticketId,
      input.eventId,
      input.customerSub,
      input.customerEmail,
      input.status,
      input.subject,
      input.errorMessage,
      input.status === "SENT" ? new Date() : null,
    ],
  );

  const record = await findByTicketId(input.ticketId);
  if (!record) {
    throw new Error("failed to persist notification record");
  }
  return record;
}

async function findById(notificationId: number): Promise<EmailNotificationRecord | null> {
  const [rows] = await pool.query<EmailNotificationRow[]>(
    "SELECT * FROM email_notifications WHERE notification_id = ?",
    [notificationId],
  );
  const row = rows[0];
  return row ? toRecord(row) : null;
}

/** The cancellation email recorded for an order, if one was ever attempted. */
export async function findCancellationByOrderId(orderId: number): Promise<EmailNotificationRecord | null> {
  const [rows] = await pool.query<EmailNotificationRow[]>(
    "SELECT * FROM email_notifications WHERE order_id = ? AND type = 'EVENT_CANCELLATION' ORDER BY notification_id LIMIT 1",
    [orderId],
  );
  const row = rows[0];
  return row ? toRecord(row) : null;
}

export interface ClaimCancellationInput {
  orderId: number;
  eventId: number;
  customerSub: string;
  customerEmail: string;
  subject: string;
}

/**
 * Records a PENDING cancellation email before it is sent. Writing first means a
 * row that cannot be written (e.g. before the EVENT_CANCELLATION migration) stops
 * the email from going out, so a caller that retries can never email twice.
 */
export async function claimCancellation(input: ClaimCancellationInput): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO email_notifications
       (order_id, ticket_id, event_id, customer_sub, customer_email, type, status, subject)
     VALUES (?, NULL, ?, ?, ?, 'EVENT_CANCELLATION', 'PENDING', ?)`,
    [input.orderId, input.eventId, input.customerSub, input.customerEmail, input.subject],
  );
  return result.insertId;
}

/** Records whether a claimed email went out. */
export async function recordOutcome(
  notificationId: number,
  status: NotificationStatus,
  errorMessage: string | null,
): Promise<EmailNotificationRecord> {
  await pool.query(
    "UPDATE email_notifications SET status = ?, error_message = ?, sent_at = ? WHERE notification_id = ?",
    [status, errorMessage, status === "SENT" ? new Date() : null, notificationId],
  );
  const record = await findById(notificationId);
  if (!record) {
    throw new Error("failed to persist notification record");
  }
  return record;
}
