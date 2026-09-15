import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const findByOrderIdMock = vi.hoisted(() => vi.fn());
const upsertOutcomeMock = vi.hoisted(() => vi.fn());
const sendOrderConfirmationMock = vi.hoisted(() => vi.fn());

vi.mock("./notificationRepository.js", () => ({
  findByOrderId: findByOrderIdMock,
  upsertOutcome: upsertOutcomeMock,
}));

vi.mock("./email.js", () => ({
  EmailService: vi.fn().mockImplementation(() => ({
    sendOrderConfirmation: sendOrderConfirmationMock,
  })),
}));

const { createApp } = await import("./app.js");

const validPayload = {
  orderId: 123,
  eventId: 45,
  customerSub: "cognito-sub-1",
  customerEmail: "buyer@example.com",
  event: { title: "Concert Night", venue: "Esplanade", startsAt: "2026-10-01T19:00:00Z" },
  order: { totalAmountCents: 5000, currency: "SGD" },
  tickets: [
    { ticketId: 1, qrToken: "abc123", description: "General Admission", seatLabel: null },
  ],
};

const app = createApp();

describe("notification service app", () => {
  beforeEach(() => {
    findByOrderIdMock.mockReset();
    upsertOutcomeMock.mockReset();
    sendOrderConfirmationMock.mockReset();
    sendOrderConfirmationMock.mockResolvedValue(undefined);
  });

  it("GET /health reports the service is up", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", service: "notification" });
  });

  describe("POST /notifications/order-confirmation", () => {
    it("rejects an invalid payload without touching the repository or email", async () => {
      const res = await request(app).post("/notifications/order-confirmation").send({});
      expect(res.status).toBe(400);
      expect(sendOrderConfirmationMock).not.toHaveBeenCalled();
      expect(upsertOutcomeMock).not.toHaveBeenCalled();
    });

    it("sends the email and persists a SENT record on a first attempt", async () => {
      findByOrderIdMock.mockResolvedValue(null);
      const sentRecord = { notificationId: 1, orderId: 123, status: "SENT" };
      upsertOutcomeMock.mockResolvedValue(sentRecord);

      const res = await request(app)
        .post("/notifications/order-confirmation")
        .send(validPayload);

      expect(sendOrderConfirmationMock).toHaveBeenCalledTimes(1);
      expect(upsertOutcomeMock).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: 123, status: "SENT", errorMessage: null }),
      );
      expect(res.status).toBe(201);
      expect(res.body).toEqual(sentRecord);
    });

    it("is idempotent: a booking already SENT is not re-emailed", async () => {
      const existing = { notificationId: 1, orderId: 123, status: "SENT" };
      findByOrderIdMock.mockResolvedValue(existing);

      const res = await request(app)
        .post("/notifications/order-confirmation")
        .send(validPayload);

      expect(sendOrderConfirmationMock).not.toHaveBeenCalled();
      expect(upsertOutcomeMock).not.toHaveBeenCalled();
      expect(res.status).toBe(200);
      expect(res.body).toEqual(existing);
    });

    it("retries a previously FAILED order instead of treating it as already sent", async () => {
      findByOrderIdMock.mockResolvedValue({ notificationId: 1, orderId: 123, status: "FAILED" });
      upsertOutcomeMock.mockResolvedValue({ notificationId: 1, orderId: 123, status: "SENT" });

      await request(app).post("/notifications/order-confirmation").send(validPayload);

      expect(sendOrderConfirmationMock).toHaveBeenCalledTimes(1);
    });

    it("records a FAILED outcome, but still responds 201, when sending throws", async () => {
      findByOrderIdMock.mockResolvedValue(null);
      sendOrderConfirmationMock.mockRejectedValue(new Error("smtp exploded"));
      upsertOutcomeMock.mockResolvedValue({ notificationId: 1, orderId: 123, status: "FAILED" });

      const res = await request(app)
        .post("/notifications/order-confirmation")
        .send(validPayload);

      expect(upsertOutcomeMock).toHaveBeenCalledWith(
        expect.objectContaining({ status: "FAILED", errorMessage: "smtp exploded" }),
      );
      expect(res.status).toBe(201);
    });
  });

  describe("GET /notifications/:orderId", () => {
    it("rejects a non-integer orderId", async () => {
      const res = await request(app).get("/notifications/abc");
      expect(res.status).toBe(400);
      expect(findByOrderIdMock).not.toHaveBeenCalled();
    });

    it("returns 404 when no notification exists for the order", async () => {
      findByOrderIdMock.mockResolvedValue(null);
      const res = await request(app).get("/notifications/999");
      expect(res.status).toBe(404);
    });

    it("returns the record when found", async () => {
      const record = { notificationId: 1, orderId: 123, status: "SENT" };
      findByOrderIdMock.mockResolvedValue(record);
      const res = await request(app).get("/notifications/123");
      expect(res.status).toBe(200);
      expect(res.body).toEqual(record);
    });
  });
});
