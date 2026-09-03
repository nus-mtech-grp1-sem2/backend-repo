-- Schema and sample-data entry point for the Docker MySQL database.
-- Docker normally runs infrastructure/sql/*.sql automatically (in name
-- order) when a new mysql-data volume is created. This file documents that
-- same order for a manual run against an existing volume.
--
-- Event artwork is binary and doesn't fit in a .sql file — after this runs,
-- also run (from repo root, not through this SQL script):
--   npx tsx local-mysql/seed-images.mts
SOURCE infrastructure/sql/02-create-all-tables.sql;
SOURCE infrastructure/sql/03-grant-schema-access.sql;
SOURCE infrastructure/sql/04-seed-sample-data.sql;
