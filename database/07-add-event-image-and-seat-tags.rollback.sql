-- Rollback for 07-add-event-image-and-seat-tags.sql.
-- Only run this if you need to undo the event photo / zone colour / seat tag columns.
--
-- WARNING: this permanently deletes any data already stored in the affected
-- columns (uploaded event photos, zone colours, seat tags). Any seat currently
-- marked BLOCKED is reset to AVAILABLE before the status enum is narrowed back,
-- since MySQL will not let you drop an enum value that is still in use — review
-- whether that's the right outcome for those seats before running this.
USE event_inventory;

UPDATE seats SET status = 'AVAILABLE' WHERE status = 'BLOCKED';

ALTER TABLE seats
  DROP COLUMN tag,
  MODIFY COLUMN status ENUM('AVAILABLE', 'HELD', 'SOLD') NOT NULL DEFAULT 'AVAILABLE';

ALTER TABLE inventory_items
  DROP COLUMN color;

ALTER TABLE events
  DROP COLUMN image_mime_type,
  DROP COLUMN image_data;
