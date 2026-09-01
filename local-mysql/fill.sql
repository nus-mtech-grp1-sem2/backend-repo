-- Replaces current Docker MySQL application data with the development dataset.
SOURCE local-mysql/clear.sql;
SOURCE infrastructure/sql/03-event-roles-and-seed.sql;
