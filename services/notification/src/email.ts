import nodemailer, { type Transporter } from "nodemailer";
import QRCode from "qrcode";
import type { OrderConfirmationRequest } from "./types.js";

const SENDER_NAME = "OneStage";

function formatCents(amountCents: number, currency: string): string {
  return `${currency} ${(amountCents / 100).toFixed(2)}`;
}

function formatStartsAt(startsAt: string): string {
  return new Date(startsAt).toLocaleString("en-SG", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "Asia/Singapore",
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderOrderConfirmationHtml(
  payload: OrderConfirmationRequest,
  ticketCids: string[],
): string {
  const ticketRows = payload.tickets
    .map((ticket, i) => {
      const seatLine = ticket.seatLabel
        ? `<div style="color:#555;font-size:13px;">Seat ${escapeHtml(ticket.seatLabel)}</div>`
        : "";
      return `
        <tr>
          <td style="padding:16px 0;border-top:1px solid #e5e5e5;">
            <div style="font-weight:600;">${escapeHtml(ticket.description)}</div>
            ${seatLine}
            <div style="color:#888;font-size:12px;">Ticket #${ticket.ticketId}</div>
          </td>
          <td style="padding:16px 0;border-top:1px solid #e5e5e5;text-align:right;">
            <img src="cid:${ticketCids[i]}" width="140" height="140" alt="QR code for ticket ${ticket.ticketId}" />
          </td>
        </tr>`;
    })
    .join("");

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#111;">
      <h1 style="font-size:20px;">Your booking is confirmed</h1>
      <p>Thanks for your purchase — here's your ticket for:</p>
      <div style="background:#f7f7f7;border-radius:8px;padding:16px;margin:16px 0;">
        <div style="font-weight:600;font-size:16px;">${escapeHtml(payload.event.title)}</div>
        <div style="color:#555;">${escapeHtml(payload.event.venue)}</div>
        <div style="color:#555;">${formatStartsAt(payload.event.startsAt)}</div>
      </div>
      <table style="width:100%;border-collapse:collapse;">${ticketRows}</table>
      <p style="margin-top:24px;color:#555;">
        Order #${payload.orderId} &middot; Total paid ${formatCents(payload.order.totalAmountCents, payload.order.currency)}
      </p>
      <p style="color:#888;font-size:12px;">
        Show the QR code above at the door for check-in. See you there!
      </p>
    </div>`;
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

  async sendOrderConfirmation(payload: OrderConfirmationRequest): Promise<void> {
    const attachments = await Promise.all(
      payload.tickets.map(async (ticket, i) => ({
        filename: `ticket-${ticket.ticketId}-qr.png`,
        content: await QRCode.toBuffer(ticket.qrToken, { width: 300, margin: 1 }),
        cid: `qr-${payload.orderId}-${i}`,
      })),
    );

    const html = renderOrderConfirmationHtml(
      payload,
      attachments.map((a) => a.cid),
    );

    await this.transporter.sendMail({
      from: `"${SENDER_NAME}" <${this.fromAddress}>`,
      to: payload.customerEmail,
      subject: `Your OneStage booking is confirmed — Order #${payload.orderId}`,
      html,
      attachments,
    });
  }
}
