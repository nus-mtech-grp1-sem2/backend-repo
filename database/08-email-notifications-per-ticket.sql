-- One confirmation email per issued ticket instead of one per order.
--
-- email_notifications used to hold a single row per order (unique on order_id).
-- It now holds one row per ticket: ticket_id is unique, order_id becomes a plain
-- index, and a booking of several tickets records one row per email sent.
-- Rows written before this migration keep ticket_id NULL (MySQL allows many
-- NULLs under a unique key).
--
-- Apply once, after 06-add-notification-schema.sql. Safe to re-run: each step
-- checks information_schema first. No GRANT change is needed;
-- 05-grant-onestage-app-schema-access.sql already covers notification.*.
USE notification;

-- Literals used by every step below are defined once here.
SET @table_name = 'email_notifications';
SET @no_op = 'SELECT 1';

SET @has_ticket_id = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = @table_name AND column_name = 'ticket_id'
);
SET @add_ticket_id = IF(
  @has_ticket_id = 1,
  @no_op,
  'ALTER TABLE email_notifications ADD COLUMN ticket_id BIGINT UNSIGNED NULL COMMENT ''logical ref -> ticketing.tickets, no FK'' AFTER order_id'
);
PREPARE add_ticket_id_statement FROM @add_ticket_id;
EXECUTE add_ticket_id_statement;
DEALLOCATE PREPARE add_ticket_id_statement;

SET @has_ticket_key = (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = @table_name AND index_name = 'uq_email_notifications_ticket'
);
SET @add_ticket_key = IF(
  @has_ticket_key > 0,
  @no_op,
  'ALTER TABLE email_notifications ADD UNIQUE KEY uq_email_notifications_ticket (ticket_id)'
);
PREPARE add_ticket_key_statement FROM @add_ticket_key;
EXECUTE add_ticket_key_statement;
DEALLOCATE PREPARE add_ticket_key_statement;

-- Keep order_id indexed (lookups by order) before its unique key is dropped.
SET @has_order_index = (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = @table_name AND index_name = 'idx_email_notifications_order'
);
SET @add_order_index = IF(
  @has_order_index > 0,
  @no_op,
  'ALTER TABLE email_notifications ADD INDEX idx_email_notifications_order (order_id)'
);
PREPARE add_order_index_statement FROM @add_order_index;
EXECUTE add_order_index_statement;
DEALLOCATE PREPARE add_order_index_statement;

SET @has_order_unique = (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = @table_name AND index_name = 'uq_email_notifications_order'
);
SET @drop_order_unique = IF(
  @has_order_unique = 0,
  @no_op,
  'ALTER TABLE email_notifications DROP INDEX uq_email_notifications_order'
);
PREPARE drop_order_unique_statement FROM @drop_order_unique;
EXECUTE drop_order_unique_statement;
DEALLOCATE PREPARE drop_order_unique_statement;
