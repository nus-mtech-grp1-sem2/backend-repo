import type {
  EventCancellationRequest,
  OrderConfirmationRequest,
  OrderConfirmationTicket,
} from "./types.js";

function isTicket(value: unknown): value is OrderConfirmationTicket {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.ticketId === "number" &&
    typeof t.qrToken === "string" &&
    typeof t.description === "string" &&
    (t.seatLabel === null || typeof t.seatLabel === "string")
  );
}

export function validateOrderConfirmation(body: unknown): OrderConfirmationRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;

  if (typeof b.orderId !== "number" || typeof b.eventId !== "number") return null;
  if (typeof b.customerSub !== "string" || typeof b.customerEmail !== "string") return null;

  const event = b.event as Record<string, unknown> | undefined;
  if (
    typeof event !== "object" ||
    event === null ||
    typeof event.title !== "string" ||
    typeof event.venue !== "string" ||
    typeof event.startsAt !== "string"
  ) {
    return null;
  }

  const order = b.order as Record<string, unknown> | undefined;
  if (
    typeof order !== "object" ||
    order === null ||
    typeof order.totalAmountCents !== "number" ||
    typeof order.currency !== "string"
  ) {
    return null;
  }

  if (!Array.isArray(b.tickets) || b.tickets.length === 0 || !b.tickets.every(isTicket)) {
    return null;
  }

  return {
    orderId: b.orderId,
    eventId: b.eventId,
    customerSub: b.customerSub,
    customerEmail: b.customerEmail,
    event: { title: event.title, venue: event.venue, startsAt: event.startsAt },
    order: { totalAmountCents: order.totalAmountCents, currency: order.currency },
    tickets: b.tickets,
  };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function validateEventCancellation(body: unknown): EventCancellationRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;

  if (typeof b.orderId !== "number" || typeof b.eventId !== "number") return null;
  if (typeof b.customerSub !== "string" || typeof b.customerEmail !== "string") return null;
  if (!isCount(b.ticketCount)) return null;

  const event = b.event as Record<string, unknown> | undefined;
  if (
    typeof event !== "object" ||
    event === null ||
    typeof event.title !== "string" ||
    typeof event.venue !== "string" ||
    typeof event.startsAt !== "string"
  ) {
    return null;
  }

  const refund = b.refund as Record<string, unknown> | undefined;
  if (
    typeof refund !== "object" ||
    refund === null ||
    !isCount(refund.amountCents) ||
    typeof refund.currency !== "string"
  ) {
    return null;
  }

  return {
    orderId: b.orderId,
    eventId: b.eventId,
    customerSub: b.customerSub,
    customerEmail: b.customerEmail,
    event: { title: event.title, venue: event.venue, startsAt: event.startsAt },
    ticketCount: b.ticketCount,
    refund: { amountCents: refund.amountCents, currency: refund.currency },
  };
}
