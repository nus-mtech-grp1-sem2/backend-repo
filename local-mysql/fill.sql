-- Replaces current Docker MySQL application data with the development dataset.
-- Rows only — event artwork is binary, so it isn't in this file. After this
-- runs, also run (from repo root, not through this SQL script):
--   npx tsx local-mysql/seed-images.mts
SOURCE local-mysql/clear.sql;
SOURCE infrastructure/sql/04-seed-sample-data.sql;
