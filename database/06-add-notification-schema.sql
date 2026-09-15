-- Adds the notification schema: sends the post-purchase confirmation email
-- (event + booking details + QR code) once an order is paid.
--
-- Apply once, in addition to 02-init-create-tables-index.sql. Safe to re-run:
-- CREATE DATABASE/TABLE IF NOT EXISTS. After this, also re-run
-- 05-grant-onestage-app-schema-access.sql so onestage_app can reach it.

CREATE DATABASE IF NOT EXISTS notification;

USE notification;
CREATE TABLE IF NOT EXISTS email_notifications (
  notification_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL COMMENT 'logical ref -> checkout.orders, no FK',
  event_id BIGINT UNSIGNED NOT NULL COMMENT 'logical ref -> event_inventory.events, no FK',
  customer_sub VARCHAR(36) NOT NULL,
  customer_email VARCHAR(255) NOT NULL,
  type ENUM('ORDER_CONFIRMATION') NOT NULL DEFAULT 'ORDER_CONFIRMATION',
  status ENUM('PENDING', 'SENT', 'FAILED') NOT NULL DEFAULT 'PENDING',
  subject VARCHAR(255) NOT NULL,
  error_message TEXT NULL,
  sent_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_email_notifications_order (order_id),
  INDEX idx_email_notifications_customer (customer_sub, created_at),
  INDEX idx_email_notifications_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
