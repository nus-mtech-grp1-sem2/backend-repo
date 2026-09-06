-- Apply once to existing event_inventory schemas.
USE event_inventory;

ALTER TABLE events
  ADD COLUMN total_seats INT UNSIGNED NOT NULL DEFAULT 1 AFTER starts_at;