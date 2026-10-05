import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const findByTicketIdMock = vi.hoisted(() => vi.fn());
const listByOrderIdMock = vi.hoisted(() => vi.fn());
const upsertOutcomeMock = vi.hoisted(() => vi.fn());
const sendTicketConfirmationMock = vi.hoisted(() => vi.fn());
const findCancellationByOrderIdMock = vi.hoisted(() => vi.fn());
const claimCancellationMock = vi.hoisted(() => vi.fn());
const recordOutcomeMock = vi.hoisted(() => vi.fn());
const sendEventCancellationMock = vi.hoisted(() => vi.fn());

vi.mock("./notificationRepository.js", () => ({
  findByTicketId: findByTicketIdMock,
  listByOrderId: listByOrderIdMock,
  upsertOutcome: upsertOutcomeMock,
  findCancellationByOrderId: findCancellationByOrderIdMock,
  claimCancellation: claimCancellationMock,
  recordOutcome: recordOutcomeMock,
}));

vi.mock("./email.js", () => ({
  EmailService: class {
    sendTicketConfirmation = sendTicketConfirmationMock;
    sendEventCancellation = sendEventCancellationMock;
  },
  ticketConfirmationSubject: (orderId: number, ticketNumber: number, total: number) =>
    `subject order ${orderId} ticket ${ticketNumber}/${total}`,
  eventCancellationSubject: (orderId: number, title: string) => `cancelled ${title} order ${orderId}`,
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

const cancellationPayload = {
  orderId: 123,
  eventId: 45,
  customerSub: "cognito-sub-1",
  customerEmail: "buyer@example.com",
  event: { title: "Concert Night", venue: "Esplanade", startsAt: "2026-10-01T19:00:00Z" },
  ticketCount: 2,
  refund: { amountCents: 10000, currency: "SGD" },
};

const cancellationRecord = (status: string) => ({
  notificationId: 900,
  orderId: 123,
  ticketId: null,
  type: "EVENT_CANCELLATION",
  status,
});

const INTERNAL_TOKEN = "test-internal-token";
const app = createApp(INTERNAL_TOKEN);
// The ticket service always sends the internal token; requests without it are tested separately.
const api = request.agent(app).set("x-internal-token", INTERNAL_TOKEN);

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
    findCancellationByOrderIdMock.mockReset();
    claimCancellationMock.mockReset();
    recordOutcomeMock.mockReset();
    sendEventCancellationMock.mockReset();
    findCancellationByOrderIdMock.mockResolvedValue(null);
    claimCancellationMock.mockResolvedValue(900);
    sendEventCancellationMock.mockResolvedValue(undefined);
    recordOutcomeMock.mockImplementation(async (_id: number, status: string) => cancellationRecord(status));
  });

  it("GET /health reports the service is up", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", service: "notification" });
  });

  describe("internal token", () => {
    const routes = [
      ["post", "/notifications/order-confirmation"],
      ["post", "/notifications/event-cancellation"],
      ["get", "/notifications/123"],
    ] as const;

    it.each(routes)("%s %s without the token is 401 and does nothing", async (method, path) => {
      const res = await request(app)[method](path).send(validPayload);
      expect(res.status).toBe(401);
      expect(sendTicketConfirmationMock).not.toHaveBeenCalled();
      expect(sendEventCancellationMock).not.toHaveBeenCalled();
      expect(listByOrderIdMock).not.toHaveBeenCalled();
    });

    it.each(routes)("%s %s with the wrong token is 401", async (method, path) => {
      const res = await request(app)[method](path).set("x-internal-token", "wrong-token").send(validPayload);
      expect(res.status).toBe(401);
      expect(sendTicketConfirmationMock).not.toHaveBeenCalled();
    });

    it("refuses every request when no token is configured, even an empty header", async () => {
      const unconfigured = createApp("");
      const res = await request(unconfigured)
        .post("/notifications/order-confirmation")
        .set("x-internal-token", "")
        .send(validPayload);
      expect(res.status).toBe(401);
      expect(sendTicketConfirmationMock).not.toHaveBeenCalled();
    });
  });

  describe("POST /notifications/order-confirmation", () => {
    it("rejects an invalid payload without touching the repository or email", async () => {
      const res = await api.post("/notifications/order-confirmation").send({});
      expect(res.status).toBe(400);
      expect(sendTicketConfirmationMock).not.toHaveBeenCalled();
      expect(upsertOutcomeMock).not.toHaveBeenCalled();
    });

    it("sends the email and inserts a SENT row for a single ticket", async () => {
      const res = await api
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
      const res = await api
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

      const res = await api
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

      const res = await api
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

      await api.post("/notifications/order-confirmation").send(validPayload);

      expect(sendTicketConfirmationMock).toHaveBeenCalledTimes(1);
    });

    it("records FAILED but still emails the other tickets when one send throws", async () => {
      sendTicketConfirmationMock.mockRejectedValueOnce(new Error("smtp exploded"));

      const res = await api
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

  describe("POST /notifications/event-cancellation", () => {
    it("rejects an invalid payload without touching the repository or email", async () => {
      const res = await api.post("/notifications/event-cancellation").send({ orderId: 123 });
      expect(res.status).toBe(400);
      expect(claimCancellationMock).not.toHaveBeenCalled();
      expect(sendEventCancellationMock).not.toHaveBeenCalled();
    });

    it("records a PENDING row, sends one email for the order, then marks it SENT", async () => {
      const res = await api.post("/notifications/event-cancellation").send(cancellationPayload);

      expect(claimCancellationMock).toHaveBeenCalledWith({
        orderId: 123,
        eventId: 45,
        customerSub: "cognito-sub-1",
        customerEmail: "buyer@example.com",
        subject: "cancelled Concert Night order 123",
      });
      expect(sendEventCancellationMock).toHaveBeenCalledTimes(1);
      expect(sendEventCancellationMock).toHaveBeenCalledWith(cancellationPayload);
      expect(recordOutcomeMock).toHaveBeenCalledWith(900, "SENT", null);
      expect(claimCancellationMock.mock.invocationCallOrder[0]).toBeLessThan(
        sendEventCancellationMock.mock.invocationCallOrder[0]!,
      );
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ orderId: 123, notification: cancellationRecord("SENT") });
    });

    it("never emails an order twice, whatever became of the first attempt", async () => {
      for (const status of ["SENT", "FAILED", "PENDING"]) {
        findCancellationByOrderIdMock.mockResolvedValue(cancellationRecord(status));

        const res = await api.post("/notifications/event-cancellation").send(cancellationPayload);

        expect(res.status).toBe(200);
        expect(res.body.notification).toEqual(cancellationRecord(status));
      }
      expect(claimCancellationMock).not.toHaveBeenCalled();
      expect(sendEventCancellationMock).not.toHaveBeenCalled();
    });

    it("sends nothing when the row cannot be recorded first", async () => {
      claimCancellationMock.mockRejectedValue(new Error("Data truncated for column 'type'"));
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const res = await api.post("/notifications/event-cancellation").send(cancellationPayload);

      expect(res.status).toBe(500);
      expect(sendEventCancellationMock).not.toHaveBeenCalled();
      logged.mockRestore();
    });

    it("records FAILED when the email cannot be sent", async () => {
      sendEventCancellationMock.mockRejectedValue(new Error("smtp exploded"));

      const res = await api.post("/notifications/event-cancellation").send(cancellationPayload);

      expect(recordOutcomeMock).toHaveBeenCalledWith(900, "FAILED", "smtp exploded");
      expect(res.status).toBe(201);
      expect(res.body.notification).toEqual(cancellationRecord("FAILED"));
    });
  });

  describe("GET /notifications/:orderId", () => {
    it("rejects a non-integer orderId", async () => {
      const res = await api.get("/notifications/abc");
      expect(res.status).toBe(400);
      expect(listByOrderIdMock).not.toHaveBeenCalled();
    });

    it("returns 404 when no notification exists for the order", async () => {
      listByOrderIdMock.mockResolvedValue([]);
      const res = await api.get("/notifications/999");
      expect(res.status).toBe(404);
    });

    it("returns every ticket's record for the order", async () => {
      const records = [record(1, "SENT"), record(2, "FAILED")];
      listByOrderIdMock.mockResolvedValue(records);
      const res = await api.get("/notifications/123");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ orderId: 123, notifications: records });
    });
  });
});
