-- Expand-only, MySQL 8.0.12+/8.4. Apply before deploying the new queue service.
-- INSTANT fails rather than silently rebuilding a large table. A metadata lock
-- is still required: abort after 10 seconds and retry in a quiet window.
-- Idempotent so an interrupted, partially applied expansion can be resumed.
-- Existing writers ignore the new columns. Before switching queue versions,
-- pause queue joins/admissions, run scripts/backfill-queue-counters.mjs --apply,
-- deploy the new queue service, then resume. Do not mix old/new join writers.
-- Roll back application code, not these columns; backfill again before retrying
-- the new version. No entries or positions are deleted or rewritten.

SET @previous_lock_wait_timeout = @@SESSION.lock_wait_timeout;
SET SESSION lock_wait_timeout = 10;

SET @queue_counter_ddl = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE `queue`.queue_sessions ADD COLUMN next_position BIGINT UNSIGNED NOT NULL DEFAULT 0, ALGORITHM=INSTANT',
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = 'queue' AND table_name = 'queue_sessions' AND column_name = 'next_position'
);
PREPARE queue_counter_statement FROM @queue_counter_ddl;
EXECUTE queue_counter_statement;
DEALLOCATE PREPARE queue_counter_statement;

SET @queue_counter_ddl = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE `queue`.queue_sessions ADD COLUMN serving_position BIGINT UNSIGNED NOT NULL DEFAULT 0, ALGORITHM=INSTANT',
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = 'queue' AND table_name = 'queue_sessions' AND column_name = 'serving_position'
);
PREPARE queue_counter_statement FROM @queue_counter_ddl;
EXECUTE queue_counter_statement;
DEALLOCATE PREPARE queue_counter_statement;

SET SESSION lock_wait_timeout = @previous_lock_wait_timeout;
