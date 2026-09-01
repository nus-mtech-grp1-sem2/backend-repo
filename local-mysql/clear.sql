-- Removes all Docker MySQL application records and resets AUTO_INCREMENT counters.
-- The schema and Admin/Customer/Helper role lookup rows are retained.
SET FOREIGN_KEY_CHECKS=0;
TRUNCATE TABLE audit_trail;
TRUNCATE TABLE event_reviews;
TRUNCATE TABLE notifications;
TRUNCATE TABLE queue_history;
TRUNCATE TABLE waiting_queues;
TRUNCATE TABLE payments;
TRUNCATE TABLE order_history;
TRUNCATE TABLE order_items;
TRUNCATE TABLE orders;
TRUNCATE TABLE inventory_logs;
TRUNCATE TABLE ticket_check_in_history;
TRUNCATE TABLE tickets;
TRUNCATE TABLE ticket_types;
TRUNCATE TABLE event_history;
TRUNCATE TABLE event_images;
TRUNCATE TABLE customer_event_roles;
TRUNCATE TABLE events;
TRUNCATE TABLE venues;
TRUNCATE TABLE customer_password_history;
TRUNCATE TABLE customer_login_history;
TRUNCATE TABLE customers;
SET FOREIGN_KEY_CHECKS=1;
