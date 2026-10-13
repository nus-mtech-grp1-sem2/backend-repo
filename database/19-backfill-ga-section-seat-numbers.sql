-- Persist deterministic section numbers for GA tickets issued before migration 18.
-- Safe to rerun: only rows without a stored number are assigned, beginning after
-- the greatest number already stored in each section.

USE ticketing;

UPDATE tickets t
JOIN checkout.order_items oi ON oi.order_item_id = t.order_item_id
SET t.section_item_id = oi.inventory_item_id
WHERE t.seat_id IS NULL
  AND t.section_item_id IS NULL
  AND oi.inventory_item_id IS NOT NULL;

DROP TEMPORARY TABLE IF EXISTS ga_ticket_number_backfill;
CREATE TEMPORARY TABLE ga_ticket_number_backfill (
  ticket_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  section_seat_number INT UNSIGNED NOT NULL
);

INSERT INTO ga_ticket_number_backfill (ticket_id, section_seat_number)
SELECT missing.ticket_id,
       COALESCE(numbered.last_number, 0) +
         ROW_NUMBER() OVER (PARTITION BY missing.section_item_id ORDER BY missing.ticket_id)
FROM tickets missing
LEFT JOIN (
  SELECT section_item_id, MAX(section_seat_number) AS last_number
  FROM tickets
  WHERE section_item_id IS NOT NULL AND section_seat_number IS NOT NULL
  GROUP BY section_item_id
) numbered ON numbered.section_item_id = missing.section_item_id
WHERE missing.seat_id IS NULL
  AND missing.section_item_id IS NOT NULL
  AND missing.section_seat_number IS NULL;

UPDATE tickets t
JOIN ga_ticket_number_backfill backfill ON backfill.ticket_id = t.ticket_id
SET t.section_seat_number = backfill.section_seat_number;

INSERT INTO ga_section_counters (inventory_item_id, last_number)
SELECT section_item_id, MAX(section_seat_number)
FROM tickets
WHERE section_item_id IS NOT NULL AND section_seat_number IS NOT NULL
GROUP BY section_item_id
ON DUPLICATE KEY UPDATE last_number = GREATEST(last_number, VALUES(last_number));

DROP TEMPORARY TABLE ga_ticket_number_backfill;
