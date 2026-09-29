import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMailMock = vi.hoisted(() => vi.fn());
const createTransportMock = vi.hoisted(() => vi.fn(() => ({ sendMail: sendMailMock })));
const toBufferMock = vi.hoisted(() => vi.fn(async () => Buffer.from("fake-qr")));

vi.mock("nodemailer", () => ({
  default: { createTransport: createTransportMock },
}));

vi.mock("qrcode", () => ({
  default: { toBuffer: toBufferMock },
}));

const { EmailService, eventCancellationSubject, formatAmount, formatStartsAt, ticketConfirmationSubject } =
  await import("./email.js");
const { default: nodemailerMock } = await import("nodemailer");
import type { EventCancellationRequest, OrderConfirmationRequest } from "./types.js";

const payload: OrderConfirmationRequest = {
  orderId: 1,
  eventId: 2,
  customerSub: "cognito-sub-1",
  customerEmail: "buyer@example.com",
  event: { title: "Concert Night", venue: "Esplanade", startsAt: "2026-10-01T19:00:00Z" },
  order: { totalAmountCents: 5000, currency: "SGD" },
  tickets: [
    { ticketId: 10, qrToken: "qr-token-1", description: "General Admission", seatLabel: null },
    { ticketId: 11, qrToken: "qr-token-2", description: "General Admission", seatLabel: "B5" },
  ],
};
const [firstTicket, secondTicket] = payload.tickets as [
  (typeof payload.tickets)[number],
  (typeof payload.tickets)[number],
];

describe("EmailService", () => {
  beforeEach(() => {
    sendMailMock.mockReset();
    createTransportMock.mockClear();
    toBufferMock.mockClear();
    sendMailMock.mockResolvedValue({});
    process.env.SMTP_USER = "onestagecontacts@gmail.com";
    process.env.SMTP_APP_PASSWORD = "app-password";
  });

  it("throws if SMTP_USER is missing", () => {
    delete process.env.SMTP_USER;
    expect(() => new EmailService()).toThrow(/SMTP_USER/);
  });

  it("throws if SMTP_APP_PASSWORD is missing", () => {
    delete process.env.SMTP_APP_PASSWORD;
    expect(() => new EmailService()).toThrow(/SMTP_APP_PASSWORD/);
  });

  it("authenticates the Gmail transport with the configured account", () => {
    new EmailService();
    expect(nodemailerMock.createTransport).toHaveBeenCalledWith({
      service: "gmail",
      auth: { user: "onestagecontacts@gmail.com", pass: "app-password" },
    });
  });

  it("sends exactly one email, with only that ticket's QR code", async () => {
    const service = new EmailService();
    await service.sendTicketConfirmation(payload, secondTicket, 2, 2);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(toBufferMock).toHaveBeenCalledTimes(1);
    expect(toBufferMock).toHaveBeenCalledWith("qr-token-2", expect.any(Object));
  });

  it("sends to the customer's email with the order and ticket in the subject", async () => {
    const service = new EmailService();
    await service.sendTicketConfirmation(payload, secondTicket, 2, 2);
    const call = sendMailMock.mock.calls[0]![0];
    expect(call.to).toBe("buyer@example.com");
    expect(call.subject).toContain("Order #1");
    expect(call.subject).toContain("Ticket 2 of 2");
    expect(call.from).toContain("onestagecontacts@gmail.com");
  });

  it("attaches the ticket's QR as one inline image referenced from the html", async () => {
    const service = new EmailService();
    await service.sendTicketConfirmation(payload, firstTicket, 1, 2);
    const call = sendMailMock.mock.calls[0]![0];
    expect(call.attachments).toHaveLength(1);
    expect(call.attachments[0].filename).toBe("ticket-10-qr.png");
    expect(call.html).toContain(`cid:${call.attachments[0].cid}`);
    expect((call.html as string).match(/<img /g)).toHaveLength(1);
  });

  it("lays the email out as Event Name, Location, Date/Time, then the QR Code", async () => {
    const service = new EmailService();
    await service.sendTicketConfirmation(payload, firstTicket, 1, 2);
    const call = sendMailMock.mock.calls[0]![0];
    const lines = (call.html as string)
      .replace(/<[^>]+>/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines.slice(0, 4)).toEqual([
      "Event Name: Concert Night",
      "Location: Esplanade",
      "Date/Time: Fri 2 Oct 2026, 3:00 AM",
      "QR Code:",
    ]);
    expect(call.text).toBe(
      [
        "Event Name: Concert Night",
        "Location: Esplanade",
        "Date/Time: Fri 2 Oct 2026, 3:00 AM",
        "",
        "QR Code:",
        "(attached as an image)",
      ].join("\n"),
    );
  });

  it("captions the ticket in a multi-ticket booking, including its seat", async () => {
    const service = new EmailService();
    await service.sendTicketConfirmation(payload, secondTicket, 2, 2);
    const call = sendMailMock.mock.calls[0]![0];
    expect(call.html).toContain("Ticket 2 of 2 · Seat B5");
  });

  it("adds no caption for a single general-admission ticket", async () => {
    const service = new EmailService();
    await service.sendTicketConfirmation(payload, firstTicket, 1, 1);
    const call = sendMailMock.mock.calls[0]![0];
    expect(call.subject).not.toContain("Ticket");
    expect(call.html).not.toContain("Ticket 1 of");
    expect(call.html).not.toContain("Seat");
  });

  it("escapes HTML in event text so it can't inject markup into the email", async () => {
    const service = new EmailService();
    const malicious: OrderConfirmationRequest = {
      ...payload,
      event: { ...payload.event, title: "<script>alert(1)</script>" },
    };
    await service.sendTicketConfirmation(malicious, firstTicket, 1, 2);
    const call = sendMailMock.mock.calls[0]![0];
    expect(call.html).not.toContain("<script>alert(1)</script>");
    expect(call.html).toContain("&lt;script&gt;");
  });

  describe("sendEventCancellation", () => {
    const cancellation: EventCancellationRequest = {
      orderId: 1,
      eventId: 2,
      customerSub: "cognito-sub-1",
      customerEmail: "buyer@example.com",
      event: { title: "Concert Night", venue: "Esplanade", startsAt: "2026-10-01T19:00:00Z" },
      ticketCount: 2,
      refund: { amountCents: 10000, currency: "SGD" },
    };

    it("sends one email to the customer, with no QR code", async () => {
      await new EmailService().sendEventCancellation(cancellation);
      expect(sendMailMock).toHaveBeenCalledTimes(1);
      const call = sendMailMock.mock.calls[0]![0];
      expect(call.to).toBe("buyer@example.com");
      expect(call.subject).toBe("Event cancelled: Concert Night — Order #1");
      expect(call.attachments).toBeUndefined();
      expect(toBufferMock).not.toHaveBeenCalled();
    });

    it("says the tickets are void and shows the refund amount and status", async () => {
      await new EmailService().sendEventCancellation(cancellation);
      const call = sendMailMock.mock.calls[0]![0];
      expect(call.text).toBe(
        [
          "We're sorry — this event has been cancelled by the organiser. Your tickets are no longer valid and cannot be used for entry.",
          "",
          "Event Name: Concert Night",
          "Location: Esplanade",
          "Date/Time: Fri 2 Oct 2026, 3:00 AM",
          "Order: #1 (2 tickets)",
          "",
          "Refund Amount: SGD 100.00",
          "Refund Status: Refund initiated",
          "A full refund will be returned to your original payment method.",
        ].join("\n"),
      );
      expect(call.html).toContain("Refund Amount: SGD 100.00");
      expect(call.html).toContain("Refund Status: Refund initiated");
    });

    it("says ticket, not tickets, for an order of one", async () => {
      await new EmailService().sendEventCancellation({ ...cancellation, ticketCount: 1 });
      expect(sendMailMock.mock.calls[0]![0].text).toContain("Order: #1 (1 ticket)");
    });

    it("escapes HTML in event text", async () => {
      await new EmailService().sendEventCancellation({
        ...cancellation,
        event: { ...cancellation.event, venue: "<img src=x onerror=alert(1)>" },
      });
      const call = sendMailMock.mock.calls[0]![0];
      expect(call.html).not.toContain("<img src=x");
      expect(call.html).toContain("&lt;img src=x");
    });
  });

  it("propagates a transport failure to the caller", async () => {
    sendMailMock.mockRejectedValue(new Error("smtp exploded"));
    const service = new EmailService();
    await expect(service.sendTicketConfirmation(payload, firstTicket, 1, 2)).rejects.toThrow(
      "smtp exploded",
    );
  });
});

describe("ticketConfirmationSubject", () => {
  it("names the order, and the ticket only when the booking has several", () => {
    expect(ticketConfirmationSubject(7, 1, 1)).toBe(
      "Your OneStage booking is confirmed — Order #7",
    );
    expect(ticketConfirmationSubject(7, 2, 3)).toBe(
      "Your OneStage booking is confirmed — Order #7, Ticket 2 of 3",
    );
  });
});

describe("formatStartsAt", () => {
  it("matches the My Events format, in Singapore time", () => {
    // 16:23 UTC on the 16th is 00:23 on the 17th in Singapore.
    expect(formatStartsAt("2026-09-16T16:23:00.000Z")).toBe("Thu 17 Sep 2026, 12:23 AM");
  });

  it("uses 12-hour time without a leading zero", () => {
    expect(formatStartsAt("2026-10-01T11:05:00Z")).toBe("Thu 1 Oct 2026, 7:05 PM");
    expect(formatStartsAt("2026-10-01T04:00:00Z")).toBe("Thu 1 Oct 2026, 12:00 PM");
  });

  it("returns an unparseable value unchanged instead of throwing", () => {
    expect(formatStartsAt("not a date")).toBe("not a date");
  });
});

describe("eventCancellationSubject", () => {
  it("names the event and the order", () => {
    expect(eventCancellationSubject(7, "Concert Night")).toBe("Event cancelled: Concert Night — Order #7");
  });
});

describe("formatAmount", () => {
  it("shows the currency code and two decimal places", () => {
    expect(formatAmount(5000, "SGD")).toBe("SGD 50.00");
    expect(formatAmount(1999, "sgd")).toBe("SGD 19.99");
    expect(formatAmount(0, "SGD")).toBe("SGD 0.00");
  });
});
