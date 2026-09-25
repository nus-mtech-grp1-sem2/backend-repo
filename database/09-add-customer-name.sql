-- Preserve the attendee display name for helper lookup and organiser rosters.
USE checkout;
SET @has_customer_name = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'orders' AND column_name = 'customer_name'
);
SET @add_customer_name = IF(
  @has_customer_name = 1,
  'SELECT 1',
  'ALTER TABLE orders ADD COLUMN customer_name VARCHAR(255) NOT NULL DEFAULT '''' AFTER customer_email'
);
PREPARE add_customer_name_statement FROM @add_customer_name;
EXECUTE add_customer_name_statement;
DEALLOCATE PREPARE add_customer_name_statement;

USE ticketing;
SET @has_ticket_customer_name = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'tickets' AND column_name = 'customer_name'
);
SET @add_ticket_customer_name = IF(
  @has_ticket_customer_name = 1,
  'SELECT 1',
  'ALTER TABLE tickets ADD COLUMN customer_name VARCHAR(255) NOT NULL DEFAULT '''' AFTER customer_email'
);
PREPARE add_ticket_customer_name_statement FROM @add_ticket_customer_name;
EXECUTE add_ticket_customer_name_statement;
DEALLOCATE PREPARE add_ticket_customer_name_statement;