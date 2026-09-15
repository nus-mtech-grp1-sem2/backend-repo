import { describe, expect, it } from "vitest";
import { validateOrderConfirmation } from "./validation.js";

const validPayload = {
  orderId: 123,
  eventId: 45,
  customerSub: "cognito-sub-1",
  customerEmail: "buyer@example.com",
  event: {
    title: "Concert Night",
    venue: "Esplanade",
    startsAt: "2026-10-01T19:00:00Z",
  },
  order: {
    totalAmountCents: 5000,
    currency: "SGD",
  },
  tickets: [
    { ticketId: 1, qrToken: "abc123", description: "General Admission", seatLabel: null },
  ],
};

describe("validateOrderConfirmation", () => {
  it("accepts a fully-formed payload and passes fields through unchanged", () => {
    const result = validateOrderConfirmation(validPayload);
    expect(result).toEqual(validPayload);
  });

  it("accepts a ticket with a seat label", () => {
    const withSeat = {
      ...validPayload,
      tickets: [{ ...validPayload.tickets[0]!, seatLabel: "A12" }],
    };
    const result = validateOrderConfirmation(withSeat);
    expect(result?.tickets[0]?.seatLabel).toBe("A12");
  });

  it.each([null, undefined, "a string", 42, []])(
    "rejects a non-object body: %p",
    (body: unknown) => {
      expect(validateOrderConfirmation(body)).toBeNull();
    },
  );

  it("rejects a payload missing orderId", () => {
    const { orderId, ...rest } = validPayload;
    expect(validateOrderConfirmation(rest)).toBeNull();
  });

  it("rejects a payload with a non-numeric eventId", () => {
    expect(validateOrderConfirmation({ ...validPayload, eventId: "45" })).toBeNull();
  });

  it("rejects a payload missing the event block", () => {
    const { event, ...rest } = validPayload;
    expect(validateOrderConfirmation(rest)).toBeNull();
  });

  it("rejects a payload with an incomplete event block", () => {
    expect(
      validateOrderConfirmation({ ...validPayload, event: { title: "Only title" } }),
    ).toBeNull();
  });

  it("rejects a payload with an incomplete order block", () => {
    expect(
      validateOrderConfirmation({ ...validPayload, order: { totalAmountCents: 5000 } }),
    ).toBeNull();
  });

  it("rejects a payload with an empty tickets array", () => {
    expect(validateOrderConfirmation({ ...validPayload, tickets: [] })).toBeNull();
  });

  it("rejects a payload where a ticket is missing a required field", () => {
    const badTicket = { ticketId: 1, description: "General Admission", seatLabel: null };
    expect(validateOrderConfirmation({ ...validPayload, tickets: [badTicket] })).toBeNull();
  });

  it("rejects a payload where seatLabel is neither string nor null", () => {
    const badTicket = { ...validPayload.tickets[0]!, seatLabel: 42 };
    expect(validateOrderConfirmation({ ...validPayload, tickets: [badTicket] })).toBeNull();
  });

  it("rejects a payload where tickets is not an array", () => {
    expect(validateOrderConfirmation({ ...validPayload, tickets: "not-an-array" })).toBeNull();
  });
});
