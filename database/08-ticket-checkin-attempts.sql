-- Ticket validation audit support. Additive and safe to run once on an existing schema.
USE ticketing;

SET @nullable_ticket_id = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'check_in_logs'
    AND column_name = 'ticket_id' AND is_nullable = 'YES'
);
SET @alter_ticket_id = IF(
  @nullable_ticket_id = 1,
  'SELECT 1',
  'ALTER TABLE check_in_logs MODIFY ticket_id BIGINT UNSIGNED NULL'
);
PREPARE alter_ticket_id_statement FROM @alter_ticket_id;
EXECUTE alter_ticket_id_statement;
DEALLOCATE PREPARE alter_ticket_id_statement;

SET @has_attempted_token = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'check_in_logs'
    AND column_name = 'attempted_token'
);
SET @alter_attempted_token = IF(
  @has_attempted_token = 1,
  'SELECT 1',
  'ALTER TABLE check_in_logs ADD COLUMN attempted_token VARCHAR(128) NULL AFTER result'
);
PREPARE alter_attempted_token_statement FROM @alter_attempted_token;
EXECUTE alter_attempted_token_statement;
DEALLOCATE PREPARE alter_attempted_token_statement;