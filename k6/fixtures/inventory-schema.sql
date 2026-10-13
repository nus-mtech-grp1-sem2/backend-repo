CREATE DATABASE IF NOT EXISTS event_inventory;
USE event_inventory;

CREATE TABLE events (
  event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organiser_sub VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  venue VARCHAR(255) NOT NULL,
  starts_at DATETIME NOT NULL,
  total_seats INT UNSIGNED NOT NULL,
  tier ENUM('TIER1_GA', 'TIER2_SEATED') NOT NULL,
  status ENUM('DRAFT', 'PUBLISHED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT'
) ENGINE=InnoDB;

CREATE TABLE inventory_items (
  inventory_item_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  total_qty INT UNSIGNED NOT NULL,
  reserved_qty INT UNSIGNED NOT NULL DEFAULT 0,
  sold_qty INT UNSIGNED NOT NULL DEFAULT 0,
  price_cents INT UNSIGNED NOT NULL,
  CONSTRAINT fk_k6_inventory_event FOREIGN KEY (event_id) REFERENCES events (event_id),
  CONSTRAINT chk_k6_inventory_counts CHECK (reserved_qty + sold_qty <= total_qty)
) ENGINE=InnoDB;

CREATE TABLE inventory_holds (
  hold_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_id BIGINT UNSIGNED NOT NULL,
  inventory_item_id BIGINT UNSIGNED NULL,
  customer_sub VARCHAR(64) NOT NULL,
  quantity INT UNSIGNED NOT NULL DEFAULT 1,
  status ENUM('ACTIVE', 'CONFIRMED', 'RELEASED', 'EXPIRED') NOT NULL DEFAULT 'ACTIVE',
  expires_at DATETIME NOT NULL,
  CONSTRAINT fk_k6_hold_event FOREIGN KEY (event_id) REFERENCES events (event_id),
  CONSTRAINT fk_k6_hold_inventory FOREIGN KEY (inventory_item_id) REFERENCES inventory_items (inventory_item_id)
) ENGINE=InnoDB;

CREATE TABLE seats (
  seat_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_id BIGINT UNSIGNED NOT NULL,
  inventory_item_id BIGINT UNSIGNED NOT NULL,
  status ENUM('AVAILABLE', 'HELD', 'SOLD') NOT NULL DEFAULT 'AVAILABLE',
  hold_id BIGINT UNSIGNED NULL,
  CONSTRAINT fk_k6_seat_event FOREIGN KEY (event_id) REFERENCES events (event_id),
  CONSTRAINT fk_k6_seat_inventory FOREIGN KEY (inventory_item_id) REFERENCES inventory_items (inventory_item_id),
  CONSTRAINT fk_k6_seat_hold FOREIGN KEY (hold_id) REFERENCES inventory_holds (hold_id)
) ENGINE=InnoDB;
