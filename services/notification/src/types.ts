export interface OrderConfirmationTicket {
  ticketId: number;
  qrToken: string;
  description: string;
  seatLabel: string | null;
}

export interface OrderConfirmationRequest {
  orderId: number;
  eventId: number;
  customerSub: string;
  customerEmail: string;
  event: {
    title: string;
    venue: string;
    startsAt: string;
  };
  order: {
    totalAmountCents: number;
    currency: string;
  };
  tickets: OrderConfirmationTicket[];
}

export type NotificationStatus = "PENDING" | "SENT" | "FAILED";

export interface EmailNotificationRecord {
  notificationId: number;
  orderId: number;
  eventId: number;
  customerSub: string;
  customerEmail: string;
  type: "ORDER_CONFIRMATION";
  status: NotificationStatus;
  subject: string;
  errorMessage: string | null;
  sentAt: string | null;
  createdAt: string;
}
