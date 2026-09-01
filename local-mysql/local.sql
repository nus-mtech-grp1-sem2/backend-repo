-- Schema and sample-data entry point for the Docker MySQL database.
-- Docker normally runs the two infrastructure SQL files automatically when a
-- new mysql-data volume is created. This file documents that same order.
CREATE DATABASE IF NOT EXISTS myonestagedb
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
SOURCE infrastructure/sql/02-create-all-tables.sql;
SOURCE infrastructure/sql/03-event-roles-and-seed.sql;
