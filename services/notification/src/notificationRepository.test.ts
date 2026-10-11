import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("./db.js", () => ({
  pool: { query: queryMock },
}));

const repository = await import("./notificationRepository.js");

function row(overrides: Record<string, unknown> = {}) {
  return {
    notification_id: 900,
    order_id: 123,
    ticket_id: 456,
    event_id: 45,
    customer_sub: "customer-1",
    customer_email: "buyer@example.com",
    type: "ORDER_CONFIRMATION",
    status: "SENT",
    subject: "Booking confirmed",
    error_message: null,
    sent_at: new Date("2026-10-11T00:00:00.000Z"),
    created_at: new Date("2026-10-10T00:00:00.000Z"),
    ...overrides,
  };
}

describe("notificationRepository", () => {
  beforeEach(() => queryMock.mockReset());

  it("maps a ticket notification row and returns null when no row exists", async () => {
    queryMock
      .mockResolvedValueOnce([[row({ ticket_id: 456 })], []])
      .mockResolvedValueOnce([[], []]);

    await expect(repository.findByTicketId(456)).resolves.toEqual({
      notificationId: 900,
      orderId: 123,
      ticketId: 456,
      eventId: 45,
      customerSub: "customer-1",
      customerEmail: "buyer@example.com",
      type: "ORDER_CONFIRMATION",
      status: "SENT",
      subject: "Booking confirmed",
      errorMessage: null,
      sentAt: "2026-10-11T00:00:00.000Z",
      createdAt: "2026-10-10T00:00:00.000Z",
    });
    await expect(repository.findByTicketId(999)).resolves.toBeNull();
    expect(queryMock).toHaveBeenNthCalledWith(
      1,
      "SELECT * FROM email_notifications WHERE ticket_id = ?",
      [456],
    );
  });

  it("lists mapped notifications for an order and returns an empty list when none exist", async () => {
    queryMock
      .mockResolvedValueOnce([
        [row({ ticket_id: null, type: "EVENT_CANCELLATION", sent_at: null })],
        [],
      ])
      .mockResolvedValueOnce([[], []]);

    const listed = await repository.listByOrderId(123);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      ticketId: null,
      type: "EVENT_CANCELLATION",
      sentAt: null,
    });
    await expect(repository.listByOrderId(999)).resolves.toEqual([]);
    expect(queryMock).toHaveBeenNthCalledWith(
      1,
      "SELECT * FROM email_notifications WHERE order_id = ? ORDER BY ticket_id, notification_id",
      [123],
    );
  });

  it.each([
    { status: "SENT", errorMessage: null, expectsSentAt: true },
    { status: "FAILED", errorMessage: "smtp unavailable", expectsSentAt: false },
  ] as const)("upserts a $status outcome with the matching sent timestamp", async ({
    status,
    errorMessage,
    expectsSentAt,
  }) => {
    queryMock
      .mockResolvedValueOnce([{}, []])
      .mockResolvedValueOnce([[row({ status, error_message: errorMessage })], []]);

    const result = await repository.upsertOutcome({
      orderId: 123,
      ticketId: 456,
      eventId: 45,
      customerSub: "customer-1",
      customerEmail: "buyer@example.com",
      status,
      subject: "Booking update",
      errorMessage,
    });

    expect(result).toMatchObject({ status, errorMessage });
    const insertParams = queryMock.mock.calls[0]?.[1] as unknown[];
    if (expectsSentAt) {
      expect(insertParams[8]).toBeInstanceOf(Date);
    } else {
      expect(insertParams[8]).toBeNull();
    }
    expect(queryMock.mock.calls[0]?.[0]).toContain("ON DUPLICATE KEY UPDATE");
    expect(queryMock.mock.calls[1]?.[1]).toEqual([456]);
  });

  it("fails an upsert if the persisted notification cannot be read back", async () => {
    queryMock.mockResolvedValueOnce([{}, []]).mockResolvedValueOnce([[], []]);

    await expect(repository.upsertOutcome({
      orderId: 123,
      ticketId: 456,
      eventId: 45,
      customerSub: "customer-1",
      customerEmail: "buyer@example.com",
      status: "FAILED",
      subject: "Booking update",
      errorMessage: "smtp unavailable",
    })).rejects.toThrow("failed to persist notification record");
  });

  it("finds the first cancellation notification for an order or returns null", async () => {
    queryMock
      .mockResolvedValueOnce([[row({ ticket_id: null, type: "EVENT_CANCELLATION" })], []])
      .mockResolvedValueOnce([[], []]);

    await expect(repository.findCancellationByOrderId(123)).resolves.toMatchObject({
      orderId: 123,
      ticketId: null,
      type: "EVENT_CANCELLATION",
    });
    await expect(repository.findCancellationByOrderId(999)).resolves.toBeNull();
    expect(queryMock.mock.calls[0]?.[0]).toContain("type = 'EVENT_CANCELLATION'");
  });

  it("claims a cancellation before sending and returns the inserted id", async () => {
    queryMock.mockResolvedValueOnce([{ insertId: 901 }, []]);

    await expect(repository.claimCancellation({
      orderId: 123,
      eventId: 45,
      customerSub: "customer-1",
      customerEmail: "buyer@example.com",
      subject: "Event cancelled",
    })).resolves.toBe(901);

    expect(queryMock.mock.calls[0]?.[0]).toContain("'EVENT_CANCELLATION', 'PENDING'");
    expect(queryMock.mock.calls[0]?.[1]).toEqual([
      123,
      45,
      "customer-1",
      "buyer@example.com",
      "Event cancelled",
    ]);
  });

  it.each([
    { status: "SENT", errorMessage: null, expectsSentAt: true },
    { status: "FAILED", errorMessage: "smtp unavailable", expectsSentAt: false },
  ] as const)("records a $status cancellation result", async ({ status, errorMessage, expectsSentAt }) => {
    queryMock
      .mockResolvedValueOnce([{}, []])
      .mockResolvedValueOnce([[row({
        notification_id: 901,
        ticket_id: null,
        type: "EVENT_CANCELLATION",
        status,
        error_message: errorMessage,
      })], []]);

    const result = await repository.recordOutcome(901, status, errorMessage);
    expect(result).toMatchObject({
      notificationId: 901,
      type: "EVENT_CANCELLATION",
      status,
      errorMessage,
    });
    const updateParams = queryMock.mock.calls[0]?.[1] as unknown[];
    if (expectsSentAt) {
      expect(updateParams[2]).toBeInstanceOf(Date);
    } else {
      expect(updateParams[2]).toBeNull();
    }
    expect(updateParams[3]).toBe(901);
  });

  it("fails a status update if the claimed notification cannot be read back", async () => {
    queryMock.mockResolvedValueOnce([{}, []]).mockResolvedValueOnce([[], []]);

    await expect(repository.recordOutcome(901, "FAILED", "smtp unavailable"))
      .rejects.toThrow("failed to persist notification record");
  });
});