import express, { type Request, type Response } from "express";
import { EmailService, ticketConfirmationSubject } from "./email.js";
import { listByOrderId, findByTicketId, upsertOutcome } from "./notificationRepository.js";
import type { EmailNotificationRecord, NotificationStatus } from "./types.js";
import { validateOrderConfirmation } from "./validation.js";

const SERVICE = "notification";

// Lazy singleton: a missing SMTP_USER/SMTP_APP_PASSWORD should not prevent the
// service from starting and answering /health — only from actually sending.
let emailService: EmailService | null = null;
function getEmailService(): EmailService {
  if (!emailService) {
    emailService = new EmailService();
  }
  return emailService;
}

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: SERVICE });
  });

  // Called by the ticket service once payment is confirmed and tickets are
  // issued. Sends one email per ticket, each carrying only that ticket's QR
  // code, and records one email_notifications row per ticket. Idempotent per
  // ticket: a ticket already emailed is not re-sent, so a caller retry never
  // double-emails a customer, and a ticket whose email FAILED is retried.
  app.post("/notifications/order-confirmation", async (req: Request, res: Response) => {
    const payload = validateOrderConfirmation(req.body);
    if (!payload) {
      res.status(400).json({ error: "invalid order confirmation payload" });
      return;
    }

    const notifications: EmailNotificationRecord[] = [];
    let attempted = false;
    // Sequential on purpose: one SMTP account, and a stable order in the response.
    for (const [index, ticket] of payload.tickets.entries()) {
      const existing = await findByTicketId(ticket.ticketId);
      if (existing && existing.status === "SENT") {
        notifications.push(existing);
        continue;
      }

      attempted = true;
      const subject = ticketConfirmationSubject(payload.orderId, index + 1, payload.tickets.length);
      let status: NotificationStatus = "SENT";
      let errorMessage: string | null = null;
      try {
        await getEmailService().sendTicketConfirmation(
          payload,
          ticket,
          index + 1,
          payload.tickets.length,
        );
      } catch (err) {
        status = "FAILED";
        errorMessage = err instanceof Error ? err.message : String(err);
      }

      notifications.push(
        await upsertOutcome({
          orderId: payload.orderId,
          ticketId: ticket.ticketId,
          eventId: payload.eventId,
          customerSub: payload.customerSub,
          customerEmail: payload.customerEmail,
          status,
          subject,
          errorMessage,
        }),
      );
    }

    res.status(attempted ? 201 : 200).json({ orderId: payload.orderId, notifications });
  });

  app.get("/notifications/:orderId", async (req: Request, res: Response) => {
    const orderId = Number(req.params.orderId);
    if (!Number.isInteger(orderId)) {
      res.status(400).json({ error: "orderId must be an integer" });
      return;
    }

    const notifications = await listByOrderId(orderId);
    if (notifications.length === 0) {
      res.status(404).json({ error: "no notification found for this order" });
      return;
    }
    res.json({ orderId, notifications });
  });

  // Express only recognizes an error handler by its four-argument arity.
  app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  });

  return app;
}
