-- Apply once to existing event_inventory schemas.
-- Backs three organiser-facing additions:
--   1. Event photo upload — stored in the DB rather than S3 so this ships
--      without any new AWS infra/IAM (see onestage-ai policy: infra changes
--      need explicit human approval; a DB column doesn't).
--   2. Per-zone/per-section colour coding on the inventory builder.
--   3. Per-seat tags (ACCESSIBLE / MAINTENANCE) for Tier 2 seat maps, with a
--      new BLOCKED seat status so a MAINTENANCE-tagged seat is actually
--      unbookable rather than just visually marked.
USE event_inventory;

ALTER TABLE events
  ADD COLUMN image_mime_type VARCHAR(100) NULL AFTER status,
  ADD COLUMN image_data MEDIUMBLOB NULL AFTER image_mime_type;

ALTER TABLE inventory_items
  ADD COLUMN color CHAR(7) NULL AFTER price_cents;

ALTER TABLE seats
  MODIFY COLUMN status ENUM('AVAILABLE', 'HELD', 'SOLD', 'BLOCKED') NOT NULL DEFAULT 'AVAILABLE',
  ADD COLUMN tag ENUM('NONE', 'ACCESSIBLE', 'MAINTENANCE') NOT NULL DEFAULT 'NONE' AFTER status;
