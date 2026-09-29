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

/** Sent once per paid order when its event is cancelled. The refund is wording only: payment is simulated. */
export interface EventCancellationRequest {
  orderId: number;
  eventId: number;
  customerSub: string;
  customerEmail: string;
  event: {
    title: string;
    venue: string;
    startsAt: string;
  };
  /** How many tickets the order bought; all of them are now void. */
  ticketCount: number;
  refund: {
    amountCents: number;
    currency: string;
  };
}

export type NotificationStatus = "PENDING" | "SENT" | "FAILED";
export type NotificationType = "ORDER_CONFIRMATION" | "EVENT_CANCELLATION";

export interface EmailNotificationRecord {
  notificationId: number;
  orderId: number;
  /** The ticket this email was for. Null on cancellation emails and on rows written before per-ticket emails. */
  ticketId: number | null;
  eventId: number;
  customerSub: string;
  customerEmail: string;
  type: NotificationType;
  status: NotificationStatus;
  subject: string;
  errorMessage: string | null;
  sentAt: string | null;
  createdAt: string;
}
