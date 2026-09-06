-- Grants the single `onestage_app` MySQL user (infrastructure/terraform/secrets.tf
-- aws_secretsmanager_secret.mysql) access to every service-owned schema.
--
-- Why this is needed: the ECS-hosted MySQL container (infrastructure/terraform/
-- ecs_mysql.tf) is started with MYSQL_USER/MYSQL_PASSWORD/MYSQL_DATABASE=onestage.
-- The official mysql:8.0 image's entrypoint auto-creates that user with
-- privileges on `onestage` ONLY. It does not know about event_inventory, queue,
-- checkout, or ticketing, which 02-init-create-tables-index.sql creates
-- separately. Without this script, every service gets "Access denied" the
-- moment it queries its schema.
--
-- Run this ONCE per MySQL instance, after 02-init-create-tables-index.sql has
-- created the four schemas. Must be run as root (or another account that
-- already holds GRANT OPTION) — `onestage_app` cannot grant itself access.
-- Re-running is safe: GRANT is idempotent and simply restates the same
-- privileges.

GRANT ALL PRIVILEGES ON event_inventory.* TO 'onestage_app'@'%';
GRANT ALL PRIVILEGES ON `queue`.*         TO 'onestage_app'@'%';
GRANT ALL PRIVILEGES ON checkout.*        TO 'onestage_app'@'%';
GRANT ALL PRIVILEGES ON ticketing.*       TO 'onestage_app'@'%';

FLUSH PRIVILEGES;
