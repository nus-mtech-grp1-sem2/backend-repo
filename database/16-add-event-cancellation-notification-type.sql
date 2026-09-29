-- Lets email_notifications record the event-cancellation email.
--
-- When an organiser cancels an event, every customer with a paid order gets one
-- email per order saying the event is cancelled, their tickets are void, and a
-- refund is on its way (payment is simulated, so the refund is wording only).
-- Those rows use type EVENT_CANCELLATION and leave ticket_id NULL, which the
-- unique key on ticket_id allows any number of.
--
-- Apply once, after 15-email-notifications-per-ticket.sql. Safe to re-run:
-- modifying the column to the same definition changes nothing. Appending a
-- value to the end of an ENUM is an in-place, metadata-only change in InnoDB
-- (no table rebuild). No GRANT change is needed;
-- 05-grant-onestage-app-schema-access.sql already covers notification.*.
--
-- Deploy this before the notification service that sends cancellation emails.
-- Until then the service cannot record a cancellation email, so it sends none.
USE notification;

ALTER TABLE email_notifications
  MODIFY COLUMN type ENUM('ORDER_CONFIRMATION', 'EVENT_CANCELLATION') NOT NULL DEFAULT 'ORDER_CONFIRMATION';
