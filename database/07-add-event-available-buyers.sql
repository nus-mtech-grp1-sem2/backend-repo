-- Run once before deploying application code that reads events.available_buyers.
-- NULL preserves the default behavior: 10% of total_seats, rounded up, minimum 1.
-- This is an additive metadata-only change on supported MySQL 8.0 versions, but
-- schedule it using the normal database change window and monitor metadata locks.

ALTER TABLE event_inventory.events
  ADD COLUMN available_buyers INT UNSIGNED NULL AFTER total_seats,
  ADD CONSTRAINT chk_events_available_buyers CHECK (
    available_buyers IS NULL OR (available_buyers >= 1 AND available_buyers <= total_seats)
  );

-- Rollback, only if the application has first been rolled back:
-- ALTER TABLE event_inventory.events
--   DROP CHECK chk_events_available_buyers,
--   DROP COLUMN available_buyers;
