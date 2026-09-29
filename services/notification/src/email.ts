import nodemailer, { type Transporter } from "nodemailer";
import QRCode from "qrcode";
import type {
  EventCancellationRequest,
  OrderConfirmationRequest,
  OrderConfirmationTicket,
} from "./types.js";

const SENDER_NAME = "OneStage";

/** Formats an event start like the customer's My Events page: "Thu 17 Sep 2026, 12:23 AM" (Singapore time). */
export function formatStartsAt(startsAt: string): string {
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) return startsAt;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Singapore",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return (
    `${part("weekday")} ${part("day")} ${part("month")} ${part("year")}, ` +
    `${part("hour")}:${part("minute")} ${part("dayPeriod").toUpperCase()}`
  );
}

/** Subject of one ticket's email. Also what is stored in email_notifications.subject. */
export function ticketConfirmationSubject(
  orderId: number,
  ticketNumber: number,
  totalTickets: number,
): string {
  const subject = `Your OneStage booking is confirmed — Order #${orderId}`;
  return totalTickets > 1 ? `${subject}, Ticket ${ticketNumber} of ${totalTickets}` : subject;
}

/** Subject of an order's cancellation email. Also what is stored in email_notifications.subject. */
export function eventCancellationSubject(orderId: number, eventTitle: string): string {
  return `Event cancelled: ${eventTitle} — Order #${orderId}`;
}

/** "SGD 50.00": the order's currency code and amount. */
export function formatAmount(amountCents: number, currency: string): string {
  const amount = (amountCents / 100).toFixed(2);
  return `${currency.toUpperCase()} ${amount}`;
}

/** Tells apart the separate emails of one booking; a lone general-admission ticket needs no caption. */
function ticketCaption(
  ticket: OrderConfirmationTicket,
  ticketNumber: number,
  totalTickets: number,
): string {
  return [
    totalTickets > 1 ? `Ticket ${ticketNumber} of ${totalTickets}` : "",
    ticket.seatLabel ? `Seat ${ticket.seatLabel}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderTicketConfirmationHtml(
  payload: OrderConfirmationRequest,
  ticket: OrderConfirmationTicket,
  ticketNumber: number,
  totalTickets: number,
  qrCid: string,
): string {
  const caption = ticketCaption(ticket, ticketNumber, totalTickets);
  const captionHtml = caption
    ? `<div style="color:#555;font-size:13px;">${escapeHtml(caption)}</div>`
    : "";

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#111;font-size:15px;line-height:1.6;">
      <div>Event Name: ${escapeHtml(payload.event.title)}</div>
      <div>Location: ${escapeHtml(payload.event.venue)}</div>
      <div>Date/Time: ${escapeHtml(formatStartsAt(payload.event.startsAt))}</div>
      <div style="margin-top:24px;">QR Code:</div>
      <div style="margin:12px 0;">
        <img src="cid:${qrCid}" width="200" height="200" alt="QR code for ticket ${ticket.ticketId}" />
        ${captionHtml}
      </div>
    </div>`;
}

function renderTicketConfirmationText(payload: OrderConfirmationRequest): string {
  return [
    `Event Name: ${payload.event.title}`,
    `Location: ${payload.event.venue}`,
    `Date/Time: ${formatStartsAt(payload.event.startsAt)}`,
    "",
    "QR Code:",
    "(attached as an image)",
  ].join("\n");
}

// Payment is simulated, so no money moves: the refund is a status shown to the customer, nothing more.
const REFUND_STATUS = "Refund initiated";
const REFUND_NOTE = "A full refund will be returned to your original payment method.";

function cancellationLines(payload: EventCancellationRequest): string[] {
  const tickets = payload.ticketCount === 1 ? "1 ticket" : `${payload.ticketCount} tickets`;
  return [
    `Event Name: ${payload.event.title}`,
    `Location: ${payload.event.venue}`,
    `Date/Time: ${formatStartsAt(payload.event.startsAt)}`,
    `Order: #${payload.orderId} (${tickets})`,
  ];
}

function renderEventCancellationHtml(payload: EventCancellationRequest): string {
  const details = cancellationLines(payload)
    .map((line) => `<div>${escapeHtml(line)}</div>`)
    .join("");
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#111;font-size:15px;line-height:1.6;">
      <p>We're sorry — this event has been cancelled by the organiser. Your tickets are no longer valid and cannot be used for entry.</p>
      ${details}
      <div style="margin-top:24px;">Refund Amount: ${escapeHtml(formatAmount(payload.refund.amountCents, payload.refund.currency))}</div>
      <div>Refund Status: ${REFUND_STATUS}</div>
      <p>${REFUND_NOTE}</p>
    </div>`;
}

function renderEventCancellationText(payload: EventCancellationRequest): string {
  return [
    "We're sorry — this event has been cancelled by the organiser. Your tickets are no longer valid and cannot be used for entry.",
    "",
    ...cancellationLines(payload),
    "",
    `Refund Amount: ${formatAmount(payload.refund.amountCents, payload.refund.currency)}`,
    `Refund Status: ${REFUND_STATUS}`,
    REFUND_NOTE,
  ].join("\n");
}

export class EmailService {
  private readonly transporter: Transporter;
  private readonly fromAddress: string;

  constructor() {
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_APP_PASSWORD;
    if (!user || !pass) {
      throw new Error("SMTP_USER and SMTP_APP_PASSWORD must be set");
    }
    this.fromAddress = user;
    this.transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass },
    });
  }

  /**
   * Sends one email for one ticket. A booking of several tickets is several
   * emails, each carrying only that ticket's QR code; ticketNumber is 1-based.
   */
  async sendTicketConfirmation(
    payload: OrderConfirmationRequest,
    ticket: OrderConfirmationTicket,
    ticketNumber: number,
    totalTickets: number,
  ): Promise<void> {
    const qr = {
      filename: `ticket-${ticket.ticketId}-qr.png`,
      content: await QRCode.toBuffer(ticket.qrToken, { width: 300, margin: 1 }),
      cid: `qr-${payload.orderId}-${ticket.ticketId}`,
    };

    await this.transporter.sendMail({
      from: `"${SENDER_NAME}" <${this.fromAddress}>`,
      to: payload.customerEmail,
      subject: ticketConfirmationSubject(payload.orderId, ticketNumber, totalTickets),
      text: renderTicketConfirmationText(payload),
      html: renderTicketConfirmationHtml(payload, ticket, ticketNumber, totalTickets, qr.cid),
      attachments: [qr],
    });
  }

  /** Tells the customer their event is cancelled, their tickets are void, and a refund is on its way. */
  async sendEventCancellation(payload: EventCancellationRequest): Promise<void> {
    await this.transporter.sendMail({
      from: `"${SENDER_NAME}" <${this.fromAddress}>`,
      to: payload.customerEmail,
      subject: eventCancellationSubject(payload.orderId, payload.event.title),
      text: renderEventCancellationText(payload),
      html: renderEventCancellationHtml(payload),
    });
  }
}
