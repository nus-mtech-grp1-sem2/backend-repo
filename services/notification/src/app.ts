import express, { type Request, type Response } from "express";
import { EmailService } from "./email.js";
import { findByOrderId, upsertOutcome } from "./notificationRepository.js";
import type { NotificationStatus } from "./types.js";
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

  // Called synchronously by the order/ticket service once payment is confirmed
  // and tickets are issued. Idempotent on orderId: a booking that was already
  // emailed is not re-sent, so a caller retry never double-emails a customer.
  app.post("/notifications/order-confirmation", async (req: Request, res: Response) => {
    const payload = validateOrderConfirmation(req.body);
    if (!payload) {
      res.status(400).json({ error: "invalid order confirmation payload" });
      return;
    }

    const existing = await findByOrderId(payload.orderId);
    if (existing && existing.status === "SENT") {
      res.status(200).json(existing);
      return;
    }

    const subject = `Your OneStage booking is confirmed — Order #${payload.orderId}`;
    let status: NotificationStatus = "SENT";
    let errorMessage: string | null = null;
    try {
      await getEmailService().sendOrderConfirmation(payload);
    } catch (err) {
      status = "FAILED";
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    const record = await upsertOutcome({
      orderId: payload.orderId,
      eventId: payload.eventId,
      customerSub: payload.customerSub,
      customerEmail: payload.customerEmail,
      status,
      subject,
      errorMessage,
    });
    res.status(201).json(record);
  });

  app.get("/notifications/:orderId", async (req: Request, res: Response) => {
    const orderId = Number(req.params.orderId);
    if (!Number.isInteger(orderId)) {
      res.status(400).json({ error: "orderId must be an integer" });
      return;
    }

    const record = await findByOrderId(orderId);
    if (!record) {
      res.status(404).json({ error: "no notification found for this order" });
      return;
    }
    res.json(record);
  });

  // Express only recognizes an error handler by its four-argument arity.
  app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  });

  return app;
}
