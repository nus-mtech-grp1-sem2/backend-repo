import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const findByTicketIdMock = vi.hoisted(() => vi.fn());
const listByOrderIdMock = vi.hoisted(() => vi.fn());
const upsertOutcomeMock = vi.hoisted(() => vi.fn());
const sendTicketConfirmationMock = vi.hoisted(() => vi.fn());

vi.mock("./notificationRepository.js", () => ({
  findByTicketId: findByTicketIdMock,
  listByOrderId: listByOrderIdMock,
  upsertOutcome: upsertOutcomeMock,
}));

vi.mock("./email.js", () => ({
  EmailService: vi.fn().mockImplementation(() => ({
    sendTicketConfirmation: sendTicketConfirmationMock,
  })),
  ticketConfirmationSubject: (orderId: number, ticketNumber: number, total: number) =>
    `subject order ${orderId} ticket ${ticketNumber}/${total}`,
}));

const { createApp } = await import("./app.js");

const ticket = (ticketId: number) => ({
  ticketId,
  qrToken: `token-${ticketId}`,
  description: "General Admission",
  seatLabel: null,
});

const validPayload = {
  orderId: 123,
  eventId: 45,
  customerSub: "cognito-sub-1",
  customerEmail: "buyer@example.com",
  event: { title: "Concert Night", venue: "Esplanade", startsAt: "2026-10-01T19:00:00Z" },
  order: { totalAmountCents: 5000, currency: "SGD" },
  tickets: [ticket(1)],
};
const twoTickets = { ...validPayload, tickets: [ticket(1), ticket(2)] };

const record = (ticketId: number, status: string) => ({
  notificationId: ticketId,
  orderId: 123,
  ticketId,
  status,
});

const app = createApp();

describe("notification service app", () => {
  beforeEach(() => {
    findByTicketIdMock.mockReset();
    listByOrderIdMock.mockReset();
    upsertOutcomeMock.mockReset();
    sendTicketConfirmationMock.mockReset();
    findByTicketIdMock.mockResolvedValue(null);
    sendTicketConfirmationMock.mockResolvedValue(undefined);
    upsertOutcomeMock.mockImplementation(async (input: { ticketId: number; status: string }) =>
      record(input.ticketId, input.status),
    );
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
      expect(sendTicketConfirmationMock).not.toHaveBeenCalled();
      expect(upsertOutcomeMock).not.toHaveBeenCalled();
    });

    it("sends the email and inserts a SENT row for a single ticket", async () => {
      const res = await request(app)
        .post("/notifications/order-confirmation")
        .send(validPayload);

      expect(sendTicketConfirmationMock).toHaveBeenCalledTimes(1);
      expect(upsertOutcomeMock).toHaveBeenCalledWith({
        orderId: 123,
        ticketId: 1,
        eventId: 45,
        customerSub: "cognito-sub-1",
        customerEmail: "buyer@example.com",
        status: "SENT",
        subject: "subject order 123 ticket 1/1",
        errorMessage: null,
      });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ orderId: 123, notifications: [record(1, "SENT")] });
    });

    it("sends one email and inserts one row per ticket", async () => {
      const res = await request(app)
        .post("/notifications/order-confirmation")
        .send(twoTickets);

      expect(sendTicketConfirmationMock).toHaveBeenCalledTimes(2);
      expect(sendTicketConfirmationMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ orderId: 123 }),
        expect.objectContaining({ ticketId: 1 }),
        1,
        2,
      );
      expect(sendTicketConfirmationMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ orderId: 123 }),
        expect.objectContaining({ ticketId: 2 }),
        2,
        2,
      );
      expect(upsertOutcomeMock).toHaveBeenCalledTimes(2);
      expect(upsertOutcomeMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ ticketId: 2, subject: "subject order 123 ticket 2/2" }),
      );
      expect(res.status).toBe(201);
      expect(res.body.notifications).toEqual([record(1, "SENT"), record(2, "SENT")]);
    });

    it("is idempotent: tickets already SENT are not re-emailed", async () => {
      findByTicketIdMock.mockImplementation(async (ticketId: number) => record(ticketId, "SENT"));

      const res = await request(app)
        .post("/notifications/order-confirmation")
        .send(twoTickets);

      expect(sendTicketConfirmationMock).not.toHaveBeenCalled();
      expect(upsertOutcomeMock).not.toHaveBeenCalled();
      expect(res.status).toBe(200);
      expect(res.body.notifications).toEqual([record(1, "SENT"), record(2, "SENT")]);
    });

    it("emails only the tickets that have not been sent yet", async () => {
      findByTicketIdMock.mockImplementation(async (ticketId: number) =>
        ticketId === 1 ? record(1, "SENT") : null,
      );

      const res = await request(app)
        .post("/notifications/order-confirmation")
        .send(twoTickets);

      expect(sendTicketConfirmationMock).toHaveBeenCalledTimes(1);
      expect(sendTicketConfirmationMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ ticketId: 2 }),
        2,
        2,
      );
      expect(res.status).toBe(201);
      expect(res.body.notifications).toEqual([record(1, "SENT"), record(2, "SENT")]);
    });

    it("retries a previously FAILED ticket instead of treating it as already sent", async () => {
      findByTicketIdMock.mockResolvedValue(record(1, "FAILED"));

      await request(app).post("/notifications/order-confirmation").send(validPayload);

      expect(sendTicketConfirmationMock).toHaveBeenCalledTimes(1);
    });

    it("records FAILED but still emails the other tickets when one send throws", async () => {
      sendTicketConfirmationMock.mockRejectedValueOnce(new Error("smtp exploded"));

      const res = await request(app)
        .post("/notifications/order-confirmation")
        .send(twoTickets);

      expect(upsertOutcomeMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ ticketId: 1, status: "FAILED", errorMessage: "smtp exploded" }),
      );
      expect(upsertOutcomeMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ ticketId: 2, status: "SENT", errorMessage: null }),
      );
      expect(res.status).toBe(201);
      expect(res.body.notifications).toEqual([record(1, "FAILED"), record(2, "SENT")]);
    });
  });

  describe("GET /notifications/:orderId", () => {
    it("rejects a non-integer orderId", async () => {
      const res = await request(app).get("/notifications/abc");
      expect(res.status).toBe(400);
      expect(listByOrderIdMock).not.toHaveBeenCalled();
    });

    it("returns 404 when no notification exists for the order", async () => {
      listByOrderIdMock.mockResolvedValue([]);
      const res = await request(app).get("/notifications/999");
      expect(res.status).toBe(404);
    });

    it("returns every ticket's record for the order", async () => {
      const records = [record(1, "SENT"), record(2, "FAILED")];
      listByOrderIdMock.mockResolvedValue(records);
      const res = await request(app).get("/notifications/123");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ orderId: 123, notifications: records });
    });
  });
});
