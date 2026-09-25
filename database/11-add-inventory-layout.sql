-- Apply once to existing event_inventory schemas.
-- Backs the organiser inventory/seat-map configuration UI: named sections for
-- Tier 2 events (with a short label prefix), and per-seat row/seat coordinates
-- so seats can be rendered as a grid without parsing seat_label strings.
-- pos_x/pos_y are unused for now (structured rows/columns, not a canvas) but
-- are added here so a future drag-and-drop seat map editor doesn't need
-- another migration.
USE event_inventory;

ALTER TABLE inventory_items
  ADD COLUMN section_code VARCHAR(10) NULL AFTER name,
  ADD COLUMN layout_config JSON NULL AFTER price_cents;

ALTER TABLE seats
  ADD COLUMN row_label VARCHAR(10) NULL AFTER seat_label,
  ADD COLUMN seat_number SMALLINT UNSIGNED NULL AFTER row_label,
  ADD COLUMN pos_x SMALLINT NULL AFTER seat_number,
  ADD COLUMN pos_y SMALLINT NULL AFTER pos_x;
