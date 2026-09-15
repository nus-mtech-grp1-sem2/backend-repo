-- One MySQL instance, four independent service-owned schemas.
CREATE DATABASE IF NOT EXISTS event_inventory;
CREATE DATABASE IF NOT EXISTS `queue`;
CREATE DATABASE IF NOT EXISTS checkout;
CREATE DATABASE IF NOT EXISTS ticketing;

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 1;
SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';
SET time_zone = '+00:00';

USE event_inventory;
CREATE TABLE events (
  event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organiser_sub VARCHAR(36) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  venue VARCHAR(255) NOT NULL,
  starts_at DATETIME NOT NULL,
  total_seats INT UNSIGNED NOT NULL,
  tier ENUM('TIER1_GA', 'TIER2_SEATED') NOT NULL,
  status ENUM('DRAFT', 'PUBLISHED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_events_status_starts_at (status, starts_at),
  INDEX idx_events_organiser_sub (organiser_sub)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE event_team_memberships (
  membership_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_id BIGINT UNSIGNED NOT NULL,
  user_sub VARCHAR(36) NOT NULL,
  user_email VARCHAR(255) NOT NULL,
  role ENUM('ORGANISER', 'HELPER') NOT NULL,
  invite_status ENUM('PENDING', 'ACCEPTED', 'REJECTED') NOT NULL DEFAULT 'ACCEPTED',
  granted_by_sub VARCHAR(36) NOT NULL,
  granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  responded_at DATETIME NULL,
  UNIQUE KEY uq_event_team_member (event_id, user_sub),
  INDEX idx_event_team_invitation (user_sub, invite_status),
  CONSTRAINT fk_team_event FOREIGN KEY (event_id) REFERENCES events (event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE inventory_items (
  inventory_item_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  total_qty INT UNSIGNED NOT NULL,
  reserved_qty INT UNSIGNED NOT NULL DEFAULT 0,
  sold_qty INT UNSIGNED NOT NULL DEFAULT 0,
  price_cents INT UNSIGNED NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_inventory_event FOREIGN KEY (event_id) REFERENCES events (event_id),
  CONSTRAINT chk_inventory_counts CHECK (reserved_qty + sold_qty <= total_qty)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE inventory_holds (
  hold_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_id BIGINT UNSIGNED NOT NULL,
  inventory_item_id BIGINT UNSIGNED NULL,
  customer_sub VARCHAR(36) NOT NULL,
  quantity INT UNSIGNED NOT NULL DEFAULT 1,
  status ENUM('ACTIVE', 'CONFIRMED', 'RELEASED', 'EXPIRED') NOT NULL DEFAULT 'ACTIVE',
  order_id BIGINT UNSIGNED NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_hold_event FOREIGN KEY (event_id) REFERENCES events (event_id),
  CONSTRAINT fk_hold_inventory FOREIGN KEY (inventory_item_id) REFERENCES inventory_items (inventory_item_id),
  INDEX idx_holds_customer_status (customer_sub, status),
  INDEX idx_holds_expiry (status, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE seats (
  seat_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_id BIGINT UNSIGNED NOT NULL,
  inventory_item_id BIGINT UNSIGNED NOT NULL,
  seat_label VARCHAR(50) NOT NULL,
  status ENUM('AVAILABLE', 'HELD', 'SOLD') NOT NULL DEFAULT 'AVAILABLE',
  hold_id BIGINT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_event_seat_label (event_id, seat_label),
  CONSTRAINT fk_seat_event FOREIGN KEY (event_id) REFERENCES events (event_id),
  CONSTRAINT fk_seat_inventory FOREIGN KEY (inventory_item_id) REFERENCES inventory_items (inventory_item_id),
  CONSTRAINT fk_seat_hold FOREIGN KEY (hold_id) REFERENCES inventory_holds (hold_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

USE `queue`;
CREATE TABLE queue_sessions (
  queue_session_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_id BIGINT UNSIGNED NOT NULL,
  opens_at DATETIME NOT NULL,
  admission_batch_size INT UNSIGNED NOT NULL,
  admission_interval_sec INT UNSIGNED NOT NULL,
  status ENUM('CLOSED', 'OPEN', 'DRAINED') NOT NULL DEFAULT 'CLOSED',
  UNIQUE KEY uq_queue_sessions_event (event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE queue_entries (
  queue_entry_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  queue_session_id BIGINT UNSIGNED NOT NULL,
  customer_sub VARCHAR(36) NOT NULL,
  position BIGINT UNSIGNED NOT NULL,
  status ENUM('WAITING', 'ADMITTED', 'IN_CHECKOUT', 'EXPIRED', 'LEFT') NOT NULL DEFAULT 'WAITING',
  joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  admitted_at DATETIME NULL,
  admission_token VARCHAR(255) NULL,
  token_expires_at DATETIME NULL,
  UNIQUE KEY uq_queue_customer (queue_session_id, customer_sub),
  CONSTRAINT fk_queue_entry_session FOREIGN KEY (queue_session_id) REFERENCES queue_sessions (queue_session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

USE checkout;
CREATE TABLE orders (
  order_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_id BIGINT UNSIGNED NOT NULL,
  customer_sub VARCHAR(36) NOT NULL,
  customer_email VARCHAR(255) NOT NULL,
  hold_id BIGINT UNSIGNED NOT NULL,
  status ENUM('PENDING', 'PAID', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
  total_amount_cents INT UNSIGNED NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'SGD',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at DATETIME NULL,
  UNIQUE KEY uq_orders_hold (hold_id),
  INDEX idx_orders_customer (customer_sub, created_at),
  INDEX idx_orders_event (event_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE order_items (
  order_item_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL,
  inventory_item_id BIGINT UNSIGNED NOT NULL,
  seat_id BIGINT UNSIGNED NULL,
  description VARCHAR(255) NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  unit_price_cents INT UNSIGNED NOT NULL,
  CONSTRAINT fk_order_item_order FOREIGN KEY (order_id) REFERENCES orders (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE payments (
  payment_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL,
  payment_token VARCHAR(255) NOT NULL,
  status ENUM('AUTHORIZED', 'CAPTURED', 'FAILED') NOT NULL,
  amount_cents INT UNSIGNED NOT NULL,
  processed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_payment_order FOREIGN KEY (order_id) REFERENCES orders (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

USE ticketing;
CREATE TABLE tickets (
  ticket_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL,
  order_item_id BIGINT UNSIGNED NOT NULL,
  event_id BIGINT UNSIGNED NOT NULL,
  customer_sub VARCHAR(36) NOT NULL,
  customer_email VARCHAR(255) NOT NULL,
  seat_id BIGINT UNSIGNED NULL,
  qr_token VARCHAR(255) NOT NULL,
  status ENUM('ISSUED', 'CHECKED_IN', 'VOID') NOT NULL DEFAULT 'ISSUED',
  issued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  checked_in_at DATETIME NULL,
  checked_in_by_sub VARCHAR(36) NULL,
  UNIQUE KEY uq_ticket_qr_token (qr_token),
  INDEX idx_tickets_customer (customer_sub, issued_at),
  INDEX idx_tickets_event (event_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE check_in_logs (
  log_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ticket_id BIGINT UNSIGNED NOT NULL,
  scanned_by_sub VARCHAR(36) NOT NULL,
  result ENUM('SUCCESS', 'DUPLICATE', 'INVALID', 'WRONG_EVENT') NOT NULL,
  scanned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_check_in_ticket FOREIGN KEY (ticket_id) REFERENCES tickets (ticket_id),
  INDEX idx_check_in_ticket (ticket_id, scanned_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
