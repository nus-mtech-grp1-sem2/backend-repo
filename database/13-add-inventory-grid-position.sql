-- Apply once to existing event_inventory schemas.
-- Adds a virtual row/column position per zone or section so organisers can
-- arrange the venue map by distance from stage (row) and left-to-right
-- placement (column) via drag-and-drop, instead of a fixed list order.
-- NULL means the zone/section hasn't been placed on the map yet.
USE event_inventory;

ALTER TABLE inventory_items
  ADD COLUMN grid_row SMALLINT UNSIGNED NULL AFTER color,
  ADD COLUMN grid_col SMALLINT UNSIGNED NULL AFTER grid_row;
