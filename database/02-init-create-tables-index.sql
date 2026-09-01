-- ===============================================================================
-- OneStage Database Initialization Script
-- ===============================================================================
-- Purpose: Create all tables, indexes, constraints, and triggers for OneStage
-- Database: onestage
-- Engine: MySQL 8.0+
-- Character Set: utf8mb4_unicode_ci
-- Version: Production v1.0
-- Created: 2026-08-25
--
-- Features:
--   - UUID Primary Keys (VARCHAR(36))
--   - 18 Tables with full referential integrity
--   - 50+ Indexes for performance optimization
--   - 30+ Foreign key constraints
--   - 7 Database triggers for 3NF compliance
--   - Comprehensive CHECK constraints
--
-- Usage:
--   mysql -u root -p onestage < 02-init-create-tables-index.sql
-- ===============================================================================

-- Set session variables for optimal performance
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 1;
SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';
SET time_zone = '+00:00';

-- ===============================================================================
-- SECTION 1: USERS & AUTHENTICATION
-- ===============================================================================

-- -----------------------------------------------------------------------------
-- Table: users
-- Purpose: Core user information; authentication credentials live in AWS Cognito
-- -----------------------------------------------------------------------------
CREATE TABLE users (
    user_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    username VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(255) NOT NULL UNIQUE,
    cognito_sub VARCHAR(36) UNIQUE,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    phone_number VARCHAR(20),
    date_of_birth DATE,
    status ENUM('active', 'suspended', 'deleted') DEFAULT 'active',
    email_verified BOOLEAN DEFAULT FALSE,
    phone_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP NULL,
    
    INDEX idx_email (email),
    INDEX idx_username (username),
    INDEX idx_status (status),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Core user table; credentials managed by AWS Cognito';

-- -----------------------------------------------------------------------------
-- Table: user_login_history
-- Purpose: Comprehensive login tracking for security audit
-- -----------------------------------------------------------------------------
CREATE TABLE user_login_history (
    login_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id VARCHAR(36) NOT NULL,
    login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ip_address VARCHAR(45),
    user_agent TEXT,
    device_type VARCHAR(50),
    login_status ENUM('success', 'failed', 'blocked') DEFAULT 'success',
    failure_reason VARCHAR(255),
    session_id VARCHAR(255),
    logout_time TIMESTAMP NULL,
    
    INDEX idx_user_id (user_id),
    INDEX idx_login_time (login_time),
    INDEX idx_login_status (login_status),
    INDEX idx_session_id (session_id),
    
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Login attempt and session tracking';


-- ===============================================================================
-- SECTION 2: EVENTS & VENUES
-- ===============================================================================

-- -----------------------------------------------------------------------------
-- Table: venues
-- Purpose: Physical or virtual event venues
-- -----------------------------------------------------------------------------
CREATE TABLE venues (
    venue_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    venue_name VARCHAR(255) NOT NULL,
    address VARCHAR(500),
    city VARCHAR(100),
    state VARCHAR(100),
    country VARCHAR(100) NOT NULL,
    postal_code VARCHAR(20),
    capacity INT UNSIGNED,
    venue_type ENUM('indoor', 'outdoor', 'virtual', 'hybrid') DEFAULT 'indoor',
    contact_email VARCHAR(255),
    contact_phone VARCHAR(20),
    latitude DECIMAL(10, 8),
    longitude DECIMAL(11, 8),
    status ENUM('active', 'inactive', 'maintenance') DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_city (city),
    INDEX idx_country (country),
    INDEX idx_status (status),
    INDEX idx_coordinates (latitude, longitude)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Event venue information';

-- -----------------------------------------------------------------------------
-- Table: events
-- Purpose: Main events/shows catalog
-- -----------------------------------------------------------------------------
CREATE TABLE events (
    event_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    event_name VARCHAR(255) NOT NULL,
    event_description TEXT,
    event_type ENUM('concert', 'sports', 'theater', 'conference', 'festival', 'other') NOT NULL,
    venue_id VARCHAR(36),
    organizer_id VARCHAR(36) NOT NULL COMMENT 'References users(user_id)',
    event_start_datetime TIMESTAMP NOT NULL,
    event_end_datetime TIMESTAMP NOT NULL,
    doors_open_time TIMESTAMP,
    age_restriction VARCHAR(20),
    dress_code VARCHAR(100),
    status ENUM('draft', 'published', 'cancelled', 'postponed', 'completed') DEFAULT 'draft',
    cancellation_reason TEXT,
    total_capacity INT UNSIGNED,
    featured BOOLEAN DEFAULT FALSE,
    banner_image_url VARCHAR(500),
    thumbnail_image_url VARCHAR(500),
    terms_conditions TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    published_at TIMESTAMP NULL,
    
    INDEX idx_event_name (event_name),
    INDEX idx_event_type (event_type),
    INDEX idx_venue_id (venue_id),
    INDEX idx_organizer_id (organizer_id),
    INDEX idx_start_datetime (event_start_datetime),
    INDEX idx_status (status),
    INDEX idx_featured (featured),
    
    FOREIGN KEY (venue_id) REFERENCES venues(venue_id) ON DELETE SET NULL,
    FOREIGN KEY (organizer_id) REFERENCES users(user_id) ON DELETE RESTRICT,
    
    CONSTRAINT chk_event_dates CHECK (event_end_datetime >= event_start_datetime)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Event catalog and details';

-- -----------------------------------------------------------------------------
-- Table: event_history
-- Purpose: Audit trail for event modifications
-- -----------------------------------------------------------------------------
CREATE TABLE event_history (
    history_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    event_id VARCHAR(36) NOT NULL,
    changed_by_user_id VARCHAR(36) NOT NULL,
    change_type ENUM('created', 'updated', 'published', 'cancelled', 'postponed') NOT NULL,
    field_changed VARCHAR(100),
    old_value TEXT,
    new_value TEXT,
    changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ip_address VARCHAR(45),
    notes TEXT,
    
    INDEX idx_event_id (event_id),
    INDEX idx_changed_by (changed_by_user_id),
    INDEX idx_changed_at (changed_at),
    INDEX idx_change_type (change_type),
    
    FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
    FOREIGN KEY (changed_by_user_id) REFERENCES users(user_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Event change history for audit';


-- -----------------------------------------------------------------------------
-- Table: users_events
-- Purpose: Per-event role assignment for users (admin or helper)
-- -----------------------------------------------------------------------------
CREATE TABLE users_events (
    user_event_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id VARCHAR(36) NOT NULL,
    event_id VARCHAR(36) NOT NULL,
    role ENUM('admin', 'helper') NOT NULL,
    assigned_by_user_id VARCHAR(36),
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status ENUM('active', 'revoked') DEFAULT 'active',

    INDEX idx_user_id (user_id),
    INDEX idx_event_id (event_id),
    INDEX idx_role (role),
    
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
    FOREIGN KEY (assigned_by_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    
    UNIQUE KEY unique_user_event (user_id, event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Per-event admin/helper role assignments';

-- ===============================================================================
-- SECTION 3: TICKETS & INVENTORY
-- ===============================================================================

-- -----------------------------------------------------------------------------
-- Table: ticket_types
-- Purpose: Ticket categories and pricing for events
-- -----------------------------------------------------------------------------
CREATE TABLE ticket_types (
    ticket_type_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    event_id VARCHAR(36) NOT NULL,
    type_name VARCHAR(100) NOT NULL,
    type_description TEXT,
    price DECIMAL(10, 2) NOT NULL CHECK (price >= 0),
    quantity_total INT UNSIGNED NOT NULL CHECK (quantity_total > 0),
    quantity_available INT UNSIGNED NOT NULL,
    quantity_sold INT UNSIGNED DEFAULT 0,
    quantity_reserved INT UNSIGNED DEFAULT 0,
    max_per_order INT UNSIGNED DEFAULT 10,
    sale_start_datetime TIMESTAMP NOT NULL,
    sale_end_datetime TIMESTAMP NOT NULL,
    status ENUM('active', 'sold_out', 'inactive') DEFAULT 'active',
    seating_section VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_event_id (event_id),
    INDEX idx_status (status),
    INDEX idx_sale_dates (sale_start_datetime, sale_end_datetime),
    INDEX idx_price (price),
    
    FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
    
    CONSTRAINT chk_sale_dates CHECK (sale_end_datetime >= sale_start_datetime),
    CONSTRAINT chk_quantities CHECK (quantity_available + quantity_sold + quantity_reserved <= quantity_total)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Ticket type definitions and inventory';

-- ===============================================================================
-- SECTION 4: ORDERS & PAYMENTS
-- ===============================================================================

-- -----------------------------------------------------------------------------
-- Table: orders
-- Purpose: User purchase orders
-- -----------------------------------------------------------------------------
CREATE TABLE orders (
    order_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    order_number VARCHAR(50) UNIQUE NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    event_id VARCHAR(36) NOT NULL,
    order_status ENUM('pending', 'confirmed', 'processing', 'completed', 'cancelled', 'refunded') DEFAULT 'pending',
    payment_status ENUM('pending', 'paid', 'failed', 'refunded', 'partial_refund') DEFAULT 'pending',
    total_amount DECIMAL(10, 2) NOT NULL CHECK (total_amount >= 0),
    discount_amount DECIMAL(10, 2) DEFAULT 0.00 CHECK (discount_amount >= 0),
    tax_amount DECIMAL(10, 2) DEFAULT 0.00 CHECK (tax_amount >= 0),
    service_fee DECIMAL(10, 2) DEFAULT 0.00 CHECK (service_fee >= 0),
    final_amount DECIMAL(10, 2) NOT NULL COMMENT 'Auto-calculated by trigger',
    currency VARCHAR(3) DEFAULT 'USD',
    promo_code VARCHAR(50),
    payment_method VARCHAR(50),
    billing_email VARCHAR(255),
    billing_phone VARCHAR(20),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    confirmed_at TIMESTAMP NULL,
    completed_at TIMESTAMP NULL,
    
    INDEX idx_order_number (order_number),
    INDEX idx_user_id (user_id),
    INDEX idx_event_id (event_id),
    INDEX idx_order_status (order_status),
    INDEX idx_payment_status (payment_status),
    INDEX idx_created_at (created_at),
    
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE RESTRICT,
    FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='User orders';

-- -----------------------------------------------------------------------------
-- Table: order_items
-- Purpose: Line items within orders
-- -----------------------------------------------------------------------------
CREATE TABLE order_items (
    order_item_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    order_id VARCHAR(36) NOT NULL,
    ticket_type_id VARCHAR(36) NOT NULL,
    ticket_id VARCHAR(36),
    quantity INT UNSIGNED NOT NULL CHECK (quantity > 0),
    unit_price DECIMAL(10, 2) NOT NULL CHECK (unit_price >= 0),
    subtotal DECIMAL(10, 2) NOT NULL COMMENT 'Auto-calculated by trigger',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_order_id (order_id),
    INDEX idx_ticket_type_id (ticket_type_id),
    INDEX idx_ticket_id (ticket_id),
    
    FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE,
    FOREIGN KEY (ticket_type_id) REFERENCES ticket_types(ticket_type_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Order line items';

-- -----------------------------------------------------------------------------
-- Table: tickets
-- Purpose: Individual ticket instances
-- Note: Must be created AFTER orders and order_items due to FK dependencies
-- -----------------------------------------------------------------------------
CREATE TABLE tickets (
    ticket_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    ticket_uuid VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
    event_id VARCHAR(36) NOT NULL,
    ticket_type_id VARCHAR(36) NOT NULL,
    order_id VARCHAR(36),
    user_id VARCHAR(36),
    ticket_code VARCHAR(100) UNIQUE NOT NULL,
    qr_code_url VARCHAR(500),
    seat_number VARCHAR(50),
    status ENUM('available', 'reserved', 'sold', 'used', 'cancelled', 'refunded') DEFAULT 'available',
    price_paid DECIMAL(10, 2) COMMENT 'Intentional denormalization for historical accuracy',
    issued_at TIMESTAMP NULL,
    used_at TIMESTAMP NULL,
    checked_in_at TIMESTAMP NULL,
    checked_in_by_user_id VARCHAR(36),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_ticket_uuid (ticket_uuid),
    INDEX idx_ticket_code (ticket_code),
    INDEX idx_event_id (event_id),
    INDEX idx_ticket_type_id (ticket_type_id),
    INDEX idx_order_id (order_id),
    INDEX idx_user_id (user_id),
    INDEX idx_status (status),
    
    FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
    FOREIGN KEY (ticket_type_id) REFERENCES ticket_types(ticket_type_id) ON DELETE RESTRICT,
    FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (checked_in_by_user_id) REFERENCES users(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Individual ticket records';

-- Now add FK constraint from order_items to tickets
ALTER TABLE order_items ADD FOREIGN KEY (ticket_id) REFERENCES tickets(ticket_id) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- Table: ticket_check_in_history
-- Purpose: Ticket validation and check-in tracking
-- -----------------------------------------------------------------------------
CREATE TABLE ticket_check_in_history (
    check_in_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    ticket_id VARCHAR(36) NOT NULL,
    event_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36),
    checked_in_by_user_id VARCHAR(36) NOT NULL,
    check_in_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    check_in_method ENUM('qr_scan', 'manual', 'nfc', 'barcode') NOT NULL,
    device_info TEXT,
    location_gate VARCHAR(50),
    ip_address VARCHAR(45),
    status ENUM('success', 'failed', 'duplicate', 'invalid') DEFAULT 'success',
    failure_reason VARCHAR(255),
    
    INDEX idx_ticket_id (ticket_id),
    INDEX idx_event_id (event_id),
    INDEX idx_user_id (user_id),
    INDEX idx_check_in_time (check_in_time),
    INDEX idx_status (status),
    
    FOREIGN KEY (ticket_id) REFERENCES tickets(ticket_id) ON DELETE CASCADE,
    FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (checked_in_by_user_id) REFERENCES users(user_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Ticket check-in audit trail';

-- -----------------------------------------------------------------------------
-- Table: order_history
-- Purpose: Order status change audit trail
-- -----------------------------------------------------------------------------
CREATE TABLE order_history (
    history_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    order_id VARCHAR(36) NOT NULL,
    status_from VARCHAR(50),
    status_to VARCHAR(50) NOT NULL,
    changed_by_user_id VARCHAR(36),
    changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reason TEXT,
    notes TEXT,
    ip_address VARCHAR(45),
    
    INDEX idx_order_id (order_id),
    INDEX idx_changed_at (changed_at),
    INDEX idx_status_to (status_to),
    
    FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE,
    FOREIGN KEY (changed_by_user_id) REFERENCES users(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Order status change history';

-- -----------------------------------------------------------------------------
-- Table: payments
-- Purpose: Payment transaction records
-- -----------------------------------------------------------------------------
CREATE TABLE payments (
    payment_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    order_id VARCHAR(36) NOT NULL,
    payment_method VARCHAR(50) NOT NULL,
    payment_provider VARCHAR(100),
    transaction_id VARCHAR(255),
    amount DECIMAL(10, 2) NOT NULL CHECK (amount >= 0),
    currency VARCHAR(3) DEFAULT 'USD',
    status ENUM('pending', 'processing', 'completed', 'failed', 'refunded', 'cancelled') DEFAULT 'pending',
    payment_date TIMESTAMP NULL,
    refund_date TIMESTAMP NULL,
    refund_amount DECIMAL(10, 2) CHECK (refund_amount >= 0),
    failure_reason TEXT,
    metadata JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_order_id (order_id),
    INDEX idx_transaction_id (transaction_id),
    INDEX idx_status (status),
    INDEX idx_payment_date (payment_date),
    
    FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Payment transaction records';

-- ===============================================================================
-- SECTION 5: QUEUE MANAGEMENT
-- ===============================================================================

-- -----------------------------------------------------------------------------
-- Table: waiting_queues
-- Purpose: Virtual waiting queue for high-demand events
-- -----------------------------------------------------------------------------
CREATE TABLE waiting_queues (
    queue_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    event_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    queue_token VARCHAR(255) UNIQUE NOT NULL,
    position INT UNSIGNED,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    estimated_wait_time INT UNSIGNED COMMENT 'Seconds',
    notified_at TIMESTAMP NULL,
    expires_at TIMESTAMP NOT NULL,
    status ENUM('waiting', 'active', 'expired', 'completed', 'cancelled') DEFAULT 'waiting',
    ip_address VARCHAR(45),
    user_agent TEXT,
    
    INDEX idx_event_id (event_id),
    INDEX idx_user_id (user_id),
    INDEX idx_queue_token (queue_token),
    INDEX idx_status (status),
    INDEX idx_position (position),
    INDEX idx_joined_at (joined_at),
    INDEX idx_expires_at (expires_at),
    
    FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    
    CONSTRAINT chk_expires_after_join CHECK (expires_at > joined_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Virtual waiting queue';

-- -----------------------------------------------------------------------------
-- Table: queue_history
-- Purpose: Queue movement audit trail
-- -----------------------------------------------------------------------------
CREATE TABLE queue_history (
    history_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    queue_id VARCHAR(36) NOT NULL,
    event_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    action_type ENUM('joined', 'position_changed', 'activated', 'expired', 'cancelled', 'completed') NOT NULL,
    old_position INT UNSIGNED,
    new_position INT UNSIGNED,
    action_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    notes TEXT,
    
    INDEX idx_queue_id (queue_id),
    INDEX idx_event_id (event_id),
    INDEX idx_user_id (user_id),
    INDEX idx_action_time (action_time),
    INDEX idx_action_type (action_type),
    
    FOREIGN KEY (queue_id) REFERENCES waiting_queues(queue_id) ON DELETE CASCADE,
    FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Queue movement history';

-- ===============================================================================
-- SECTION 6: NOTIFICATIONS
-- ===============================================================================

-- -----------------------------------------------------------------------------
-- Table: notifications
-- Purpose: System notifications to users
-- -----------------------------------------------------------------------------
CREATE TABLE notifications (
    notification_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id VARCHAR(36) NOT NULL,
    notification_type ENUM('order', 'event', 'queue', 'payment', 'reminder', 'system', 'marketing') NOT NULL,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    related_entity_type VARCHAR(50),
    related_entity_id VARCHAR(36),
    priority ENUM('low', 'medium', 'high', 'urgent') DEFAULT 'medium',
    status ENUM('pending', 'sent', 'delivered', 'read', 'failed') DEFAULT 'pending',
    channel ENUM('email', 'sms', 'push', 'in_app') NOT NULL,
    sent_at TIMESTAMP NULL,
    read_at TIMESTAMP NULL,
    retry_count INT DEFAULT 0,
    error_message TEXT,
    metadata JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_user_id (user_id),
    INDEX idx_notification_type (notification_type),
    INDEX idx_status (status),
    INDEX idx_channel (channel),
    INDEX idx_created_at (created_at),
    INDEX idx_related_entity (related_entity_type, related_entity_id),
    
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='User notifications';

-- ===============================================================================
-- SECTION 7: REVIEWS & RATINGS
-- ===============================================================================

-- -----------------------------------------------------------------------------
-- Table: event_reviews
-- Purpose: User reviews and ratings
-- -----------------------------------------------------------------------------
CREATE TABLE event_reviews (
    review_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    event_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    order_id VARCHAR(36),
    rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    review_title VARCHAR(255),
    review_text TEXT,
    verified_purchase BOOLEAN DEFAULT FALSE,
    status ENUM('pending', 'approved', 'rejected', 'flagged') DEFAULT 'pending',
    helpful_count INT UNSIGNED DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_event_id (event_id),
    INDEX idx_user_id (user_id),
    INDEX idx_rating (rating),
    INDEX idx_status (status),
    INDEX idx_created_at (created_at),
    
    FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE SET NULL,
    
    UNIQUE KEY unique_review (event_id, user_id, order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Event reviews and ratings';

-- ===============================================================================
-- SECTION 8: AUDIT
-- ===============================================================================

-- -----------------------------------------------------------------------------
-- Table: audit_trail
-- Purpose: Comprehensive system audit trail
-- -----------------------------------------------------------------------------
CREATE TABLE audit_trail (
    audit_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    table_name VARCHAR(100) NOT NULL,
    record_id VARCHAR(36) NOT NULL,
    action_type ENUM('INSERT', 'UPDATE', 'DELETE') NOT NULL,
    old_values JSON,
    new_values JSON,
    changed_by_user_id VARCHAR(36),
    changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ip_address VARCHAR(45),
    user_agent TEXT,
    
    INDEX idx_table_record (table_name, record_id),
    INDEX idx_action_type (action_type),
    INDEX idx_changed_by (changed_by_user_id),
    INDEX idx_changed_at (changed_at),
    
    FOREIGN KEY (changed_by_user_id) REFERENCES users(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='System-wide audit trail';

-- ===============================================================================
-- SECTION 9: DATABASE TRIGGERS (3NF COMPLIANCE)
-- ===============================================================================

-- -----------------------------------------------------------------------------
-- Trigger: orders_calculate_final_amount_insert
-- Purpose: Auto-calculate final_amount on INSERT
-- Formula: final_amount = total_amount - discount_amount + tax_amount + service_fee
-- -----------------------------------------------------------------------------
DELIMITER $$

CREATE TRIGGER orders_calculate_final_amount_insert
BEFORE INSERT ON orders
FOR EACH ROW
BEGIN
    SET NEW.final_amount = NEW.total_amount - NEW.discount_amount + NEW.tax_amount + NEW.service_fee;
END$$

DELIMITER ;

-- -----------------------------------------------------------------------------
-- Trigger: orders_calculate_final_amount_update
-- Purpose: Auto-calculate final_amount on UPDATE
-- -----------------------------------------------------------------------------
DELIMITER $$

CREATE TRIGGER orders_calculate_final_amount_update
BEFORE UPDATE ON orders
FOR EACH ROW
BEGIN
    SET NEW.final_amount = NEW.total_amount - NEW.discount_amount + NEW.tax_amount + NEW.service_fee;
END$$

DELIMITER ;

-- -----------------------------------------------------------------------------
-- Trigger: order_items_calculate_subtotal_insert
-- Purpose: Auto-calculate subtotal on INSERT
-- Formula: subtotal = quantity * unit_price
-- -----------------------------------------------------------------------------
DELIMITER $$

CREATE TRIGGER order_items_calculate_subtotal_insert
BEFORE INSERT ON order_items
FOR EACH ROW
BEGIN
    SET NEW.subtotal = NEW.quantity * NEW.unit_price;
END$$

DELIMITER ;

-- -----------------------------------------------------------------------------
-- Trigger: order_items_calculate_subtotal_update
-- Purpose: Auto-calculate subtotal on UPDATE
-- -----------------------------------------------------------------------------
DELIMITER $$

CREATE TRIGGER order_items_calculate_subtotal_update
BEFORE UPDATE ON order_items
FOR EACH ROW
BEGIN
    SET NEW.subtotal = NEW.quantity * NEW.unit_price;
END$$

DELIMITER ;

-- -----------------------------------------------------------------------------
-- Trigger: tickets_update_quantities_on_sold
-- Purpose: Update inventory when ticket status changes to 'sold'
-- Cases:
--   1. reserved → sold: increment quantity_sold, decrement quantity_reserved
--   2. available → sold: increment quantity_sold, decrement quantity_available
-- -----------------------------------------------------------------------------
DELIMITER $$

CREATE TRIGGER tickets_update_quantities_on_sold
AFTER UPDATE ON tickets
FOR EACH ROW
BEGIN
    -- Reserved → Sold
    IF OLD.status = 'reserved' AND NEW.status = 'sold' THEN
        UPDATE ticket_types 
        SET 
            quantity_sold = quantity_sold + 1,
            quantity_reserved = quantity_reserved - 1,
            status = CASE 
                WHEN (quantity_sold + 1) >= quantity_total THEN 'sold_out'
                ELSE status
            END
        WHERE ticket_type_id = NEW.ticket_type_id;
        
    -- Available → Sold (direct purchase)
    ELSEIF OLD.status = 'available' AND NEW.status = 'sold' THEN
        UPDATE ticket_types 
        SET 
            quantity_sold = quantity_sold + 1,
            quantity_available = quantity_available - 1,
            status = CASE 
                WHEN (quantity_sold + 1) >= quantity_total THEN 'sold_out'
                ELSE status
            END
        WHERE ticket_type_id = NEW.ticket_type_id;
    END IF;
END$$

DELIMITER ;

-- -----------------------------------------------------------------------------
-- Trigger: tickets_update_quantities_on_reserved
-- Purpose: Update inventory when ticket is reserved
-- Case: available → reserved: decrement quantity_available, increment quantity_reserved
-- -----------------------------------------------------------------------------
DELIMITER $$

CREATE TRIGGER tickets_update_quantities_on_reserved
AFTER UPDATE ON tickets
FOR EACH ROW
BEGIN
    -- Available → Reserved
    IF OLD.status = 'available' AND NEW.status = 'reserved' THEN
        UPDATE ticket_types 
        SET 
            quantity_available = quantity_available - 1,
            quantity_reserved = quantity_reserved + 1
        WHERE ticket_type_id = NEW.ticket_type_id;
    END IF;
END$$

DELIMITER ;

-- -----------------------------------------------------------------------------
-- Trigger: tickets_update_quantities_on_cancel_refund
-- Purpose: Update inventory when ticket is cancelled or refunded
-- Cases:
--   1. sold → cancelled/refunded: decrement quantity_sold, increment quantity_available
--   2. reserved → cancelled/refunded: decrement quantity_reserved, increment quantity_available
-- Also reactivates 'sold_out' status to 'active'
-- -----------------------------------------------------------------------------
DELIMITER $$

CREATE TRIGGER tickets_update_quantities_on_cancel_refund
AFTER UPDATE ON tickets
FOR EACH ROW
BEGIN
    -- Sold → Cancelled/Refunded
    IF OLD.status = 'sold' AND NEW.status IN ('cancelled', 'refunded') THEN
        UPDATE ticket_types 
        SET 
            quantity_sold = quantity_sold - 1,
            quantity_available = quantity_available + 1,
            status = CASE 
                WHEN status = 'sold_out' THEN 'active'
                ELSE status
            END
        WHERE ticket_type_id = NEW.ticket_type_id;
        
    -- Reserved → Cancelled
    ELSEIF OLD.status = 'reserved' AND NEW.status IN ('cancelled', 'refunded') THEN
        UPDATE ticket_types 
        SET 
            quantity_reserved = quantity_reserved - 1,
            quantity_available = quantity_available + 1
        WHERE ticket_type_id = NEW.ticket_type_id;
    END IF;
END$$

DELIMITER ;

-- ===============================================================================
-- INITIALIZATION COMPLETE
-- ===============================================================================

-- Verify table creation
SELECT 
    'Database initialization completed successfully!' AS Status,
    COUNT(*) AS TotalTables
FROM information_schema.tables 
WHERE table_schema = DATABASE();

-- Show trigger count
SELECT 
    'Triggers created successfully!' AS Status,
    COUNT(*) AS TotalTriggers
FROM information_schema.triggers 
WHERE trigger_schema = DATABASE();

-- Display summary
SELECT 
    'OneStage Database v1.0' AS Database,
    'Production Ready' AS Status,
    '18 Tables, 7 Triggers, 50+ Indexes' AS Features,
    'UUID Primary Keys + 3NF Compliance' AS Architecture,
    NOW() AS CreatedAt;

-- ===============================================================================
-- END OF SCRIPT
-- ===============================================================================
