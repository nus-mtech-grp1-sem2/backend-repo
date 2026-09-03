-- Add the design-standard assignment status to existing databases.
-- Fresh databases already receive this column from 03-event-roles-and-seed.sql.

USE myonestagedb;

SET @has_status_column = (
    SELECT COUNT(*)
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'customer_event_roles'
      AND column_name = 'status'
);

SET @add_status_column = IF(
    @has_status_column = 0,
    'ALTER TABLE customer_event_roles ADD COLUMN status ENUM(\'ACTIVE\', \'REVOKED\') NOT NULL DEFAULT \'ACTIVE\' AFTER added_by_customer_id',
    'SELECT 1'
);

PREPARE add_status_column_statement FROM @add_status_column;
EXECUTE add_status_column_statement;
DEALLOCATE PREPARE add_status_column_statement;