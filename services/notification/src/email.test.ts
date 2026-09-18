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

const { EmailService } = await import("./email.js");
const { default: nodemailerMock } = await import("nodemailer");
import type { OrderConfirmationRequest } from "./types.js";

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

  it("generates one QR code per ticket, keyed by that ticket's qrToken", async () => {
    const service = new EmailService();
    await service.sendOrderConfirmation(payload);
    expect(toBufferMock).toHaveBeenCalledTimes(2);
    expect(toBufferMock).toHaveBeenCalledWith("qr-token-1", expect.any(Object));
    expect(toBufferMock).toHaveBeenCalledWith("qr-token-2", expect.any(Object));
  });

  it("sends to the customer's email with the order id in the subject", async () => {
    const service = new EmailService();
    await service.sendOrderConfirmation(payload);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const call = sendMailMock.mock.calls[0]![0];
    expect(call.to).toBe("buyer@example.com");
    expect(call.subject).toContain("Order #1");
    expect(call.from).toContain("onestagecontacts@gmail.com");
  });

  it("attaches one inline image per ticket, each cid referenced from the html", async () => {
    const service = new EmailService();
    await service.sendOrderConfirmation(payload);
    const call = sendMailMock.mock.calls[0]![0];
    expect(call.attachments).toHaveLength(2);
    for (const attachment of call.attachments) {
      expect(call.html).toContain(`cid:${attachment.cid}`);
    }
  });

  it("includes the event title, venue, and each ticket's seat label in the html", async () => {
    const service = new EmailService();
    await service.sendOrderConfirmation(payload);
    const call = sendMailMock.mock.calls[0]![0];
    expect(call.html).toContain("Concert Night");
    expect(call.html).toContain("Esplanade");
    expect(call.html).toContain("Seat B5");
  });

  it("escapes HTML in event text so it can't inject markup into the email", async () => {
    const service = new EmailService();
    const malicious: OrderConfirmationRequest = {
      ...payload,
      event: { ...payload.event, title: "<script>alert(1)</script>" },
    };
    await service.sendOrderConfirmation(malicious);
    const call = sendMailMock.mock.calls[0]![0];
    expect(call.html).not.toContain("<script>alert(1)</script>");
    expect(call.html).toContain("&lt;script&gt;");
  });

  it("propagates a transport failure to the caller", async () => {
    sendMailMock.mockRejectedValue(new Error("smtp exploded"));
    const service = new EmailService();
    await expect(service.sendOrderConfirmation(payload)).rejects.toThrow("smtp exploded");
  });
});
