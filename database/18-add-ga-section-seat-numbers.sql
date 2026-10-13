-- General-admission tickets get a seat number within their section when they
-- are issued, e.g. "Standing Floor · No. 12". Seated (TIER2) tickets keep their
-- real seat via seat_id and are not numbered.
--
--   tickets.section_item_id       the section (event_inventory.inventory_items)
--                                 the ticket was numbered in; NULL for seated
--                                 tickets and tickets issued before this change.
--   tickets.section_seat_number   1, 2, 3 ... within that section, in issue order.
--   ga_section_counters           the last number handed out per section. The
--                                 ticket service increments it in the issuing
--                                 transaction, so a rolled-back issuance gives its
--                                 numbers back and numbers are never duplicated.
--
-- Apply once, after 17-add-event-team-soft-revoke.sql. Expand only: the current
-- ticket service keeps working against the new schema. Adding nullable columns
-- is instant on MySQL 8.0.29+; the unique key allows any number of NULL pairs,
-- so existing tickets are unaffected. No GRANT change is needed.

USE ticketing;

ALTER TABLE tickets
  ADD COLUMN section_item_id BIGINT UNSIGNED NULL AFTER seat_id,
  ADD COLUMN section_seat_number INT UNSIGNED NULL AFTER section_item_id,
  ADD UNIQUE KEY uq_ticket_section_seat (section_item_id, section_seat_number);

CREATE TABLE IF NOT EXISTS ga_section_counters (
  inventory_item_id BIGINT UNSIGNED NOT NULL PRIMARY KEY COMMENT 'logical ref -> event_inventory.inventory_items, no FK',
  last_number INT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
