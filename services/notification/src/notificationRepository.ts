import type { RowDataPacket } from "mysql2";
import { pool } from "./db.js";
import type { EmailNotificationRecord, NotificationStatus } from "./types.js";

interface EmailNotificationRow extends RowDataPacket {
  notification_id: number;
  order_id: number;
  event_id: number;
  customer_sub: string;
  customer_email: string;
  type: "ORDER_CONFIRMATION";
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

export async function findByOrderId(orderId: number): Promise<EmailNotificationRecord | null> {
  const [rows] = await pool.query<EmailNotificationRow[]>(
    "SELECT * FROM email_notifications WHERE order_id = ?",
    [orderId],
  );
  const row = rows[0];
  return row ? toRecord(row) : null;
}

export interface UpsertOutcomeInput {
  orderId: number;
  eventId: number;
  customerSub: string;
  customerEmail: string;
  status: NotificationStatus;
  subject: string;
  errorMessage: string | null;
}

export async function upsertOutcome(input: UpsertOutcomeInput): Promise<EmailNotificationRecord> {
  await pool.query(
    `INSERT INTO email_notifications
       (order_id, event_id, customer_sub, customer_email, type, status, subject, error_message, sent_at)
     VALUES (?, ?, ?, ?, 'ORDER_CONFIRMATION', ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       status = VALUES(status),
       subject = VALUES(subject),
       error_message = VALUES(error_message),
       sent_at = VALUES(sent_at)`,
    [
      input.orderId,
      input.eventId,
      input.customerSub,
      input.customerEmail,
      input.status,
      input.subject,
      input.errorMessage,
      input.status === "SENT" ? new Date() : null,
    ],
  );

  const record = await findByOrderId(input.orderId);
  if (!record) {
    throw new Error("failed to persist notification record");
  }
  return record;
}
