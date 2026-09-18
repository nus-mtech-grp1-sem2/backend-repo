-- Apply once to existing event_inventory schemas (after 08-add-inventory-grid-position.sql).
-- Lets organisers pick their own grid size per event (instead of a fixed 6x8)
-- and lets a single zone/section span more than one row/column, so adjacent
-- cells can be visually merged into one block on the venue map.
USE event_inventory;

ALTER TABLE inventory_items
  ADD COLUMN grid_row_span SMALLINT UNSIGNED NOT NULL DEFAULT 1 AFTER grid_col,
  ADD COLUMN grid_col_span SMALLINT UNSIGNED NOT NULL DEFAULT 1 AFTER grid_row_span;

CREATE TABLE IF NOT EXISTS event_grid_settings (
  event_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  grid_rows SMALLINT UNSIGNED NOT NULL DEFAULT 6,
  grid_cols SMALLINT UNSIGNED NOT NULL DEFAULT 8,
  CONSTRAINT fk_grid_settings_event FOREIGN KEY (event_id) REFERENCES events (event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
