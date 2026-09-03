-- Removes all Docker MySQL application records across all four schemas and
-- resets AUTO_INCREMENT counters. The schemas and tables themselves are
-- retained — only the rows are cleared.
SET FOREIGN_KEY_CHECKS=0;

USE onestagedb;
TRUNCATE TABLE seats;
TRUNCATE TABLE inventory_holds;
TRUNCATE TABLE inventory_items;
TRUNCATE TABLE event_team_memberships;
TRUNCATE TABLE event_images;
TRUNCATE TABLE events;

USE `queue`;
TRUNCATE TABLE queue_entries;
TRUNCATE TABLE queue_sessions;

USE checkout;
TRUNCATE TABLE payments;
TRUNCATE TABLE order_items;
TRUNCATE TABLE orders;

USE ticketing;
TRUNCATE TABLE check_in_logs;
TRUNCATE TABLE tickets;

SET FOREIGN_KEY_CHECKS=1;
