-- Grants the single `onestage` MySQL user (docker-compose's MYSQL_USER, and
-- the same user services connect as in AWS) access to every service-owned
-- schema.
--
-- Why this is needed: the mysql:8.0 image's entrypoint auto-creates
-- MYSQL_USER with privileges on MYSQL_DATABASE only. `02-create-all-tables.sql`
-- creates four schemas (onestagedb, queue, checkout, ticketing), so
-- without this grant every service but the one matching MYSQL_DATABASE gets
-- "Access denied" the moment it queries its schema.
--
-- Re-running is safe: GRANT is idempotent and simply restates the same
-- privileges.
GRANT ALL PRIVILEGES ON onestagedb.*      TO 'onestage'@'%';
GRANT ALL PRIVILEGES ON `queue`.*         TO 'onestage'@'%';
GRANT ALL PRIVILEGES ON checkout.*        TO 'onestage'@'%';
GRANT ALL PRIVILEGES ON ticketing.*       TO 'onestage'@'%';

FLUSH PRIVILEGES;
