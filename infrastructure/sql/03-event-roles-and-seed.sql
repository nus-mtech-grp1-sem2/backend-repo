-- Event-scoped roles, plus sample data for local development.
--
-- This file is additive: it never touches the tables `02-create-all-tables.sql`
-- defines. It only adds the two new tables the app needs (`roles` and
-- `customer_event_roles`) and seeds every table with data that mirrors
-- `core-frontend/src/app/core/catalog.ts`, so the app looks the same the
-- moment it starts reading from MySQL instead of that static file.
--
-- Runs automatically on first container start (docker-entrypoint-initdb.d
-- executes every *.sql file here in name order, after 02-create-all-tables.sql).
-- It does NOT run again on an existing data volume — `docker compose down -v`
-- before `docker compose up` if you need to reseed a database that already
-- has data in it.
--
-- Model (see whiteboard): a customer's relationship to one event is a role —
-- Admin, Customer or Helper — recorded as one row per (customer, event) pair.
-- The composite primary key is exactly that pair, so a customer holds at most
-- one role per event.

USE myonestagedb;

SET NAMES utf8mb4;
SET CHARACTER SET utf8mb4;

-- =============================================================================
-- 1. NEW TABLES: roles and the customer/event/role relationship
-- =============================================================================

CREATE TABLE IF NOT EXISTS roles (
    role_id TINYINT UNSIGNED PRIMARY KEY,
    role_name VARCHAR(20) NOT NULL UNIQUE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO roles (role_id, role_name) VALUES
    (1, 'Admin'),
    (2, 'Customer'),
    (3, 'Helper')
ON DUPLICATE KEY UPDATE role_name = VALUES(role_name);

-- Which role a customer holds for one event. Composite primary key from the
-- two foreign keys, per the whiteboard model — a customer can only hold one
-- role on a given event, and adding them again with a different role just
-- overwrites the row (see the event service's `ON DUPLICATE KEY UPDATE`).
--
-- Admin and Helper rows grant event-scoped staff access. Customer rows record
-- attendance/purchase membership so every user/event/role relationship follows
-- the same whiteboard model.
CREATE TABLE IF NOT EXISTS customer_event_roles (
    customer_id BIGINT UNSIGNED NOT NULL,
    event_id BIGINT UNSIGNED NOT NULL,
    role_id TINYINT UNSIGNED NOT NULL,
    added_by_customer_id BIGINT UNSIGNED,
    status ENUM('ACTIVE', 'REVOKED') NOT NULL DEFAULT 'ACTIVE',
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (customer_id, event_id),

    INDEX idx_event_id (event_id),
    INDEX idx_role_id (role_id),

    FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE CASCADE,
    FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
    FOREIGN KEY (role_id) REFERENCES roles(role_id) ON DELETE RESTRICT,
    FOREIGN KEY (added_by_customer_id) REFERENCES customers(customer_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Optional organiser-uploaded artwork. Keeping the binary in MySQL makes the
-- local setup persistent without adding a filesystem volume or cloud storage.
CREATE TABLE IF NOT EXISTS event_images (
    event_id BIGINT UNSIGNED PRIMARY KEY,
    mime_type VARCHAR(50) NOT NULL,
    image_data MEDIUMBLOB NOT NULL,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================================
-- 2. SEED: customers
-- =============================================================================

-- `password_hash` is NOT NULL in the existing schema, but this app never
-- checks it — Cognito owns authentication. Real accounts get a row here the
-- first time they touch an event-scoped endpoint (see event-service's
-- `resolveCustomer`), matched and updated by email; the placeholder value
-- below only ever appears for the seed rows.
INSERT INTO customers (customer_id, customer_name, admin_ind, email, password_hash, first_name, last_name, status, email_verified) VALUES
    (1, 'system-organiser', 'Y', 'organiser@onestage.io', 'cognito-managed', 'System', 'Organiser', 'active', TRUE),
    (2, 'amanda-lim', 'N', 'amanda.lim@example.com', 'cognito-managed', 'Amanda', 'Lim', 'active', TRUE),
    (3, 'rachel-tan', 'N', 'rachel.tan@example.com', 'cognito-managed', 'Rachel', 'Tan', 'active', TRUE),
    (4, 'weijie-koh', 'N', 'weijie.koh@example.com', 'cognito-managed', 'Wei Jie', 'Koh', 'active', TRUE),
    (5, 'nur-aisyah', 'N', 'nur.aisyah@example.com', 'cognito-managed', 'Nur', 'Aisyah', 'active', TRUE),
    (6, 'marcus-ong', 'N', 'marcus.ong@example.com', 'cognito-managed', 'Marcus', 'Ong', 'active', TRUE),
    (7, 'priya-sharma', 'N', 'priya.sharma@example.com', 'cognito-managed', 'Priya', 'Sharma', 'active', TRUE),
    (8, 'jamie-helper', 'N', 'jamie@onestage.io', 'cognito-managed', 'Jamie', 'Helper', 'active', TRUE);

-- =============================================================================
-- 3. SEED: venues (matches VENUES in catalog.ts)
-- =============================================================================

INSERT INTO venues (venue_id, venue_name, city, country, capacity, venue_type, status) VALUES
    (1, 'Marina Bay Arena', 'Singapore', 'Singapore', 12000, 'indoor', 'active'),
    (2, 'Kallang Grand Stadium', 'Singapore', 'Singapore', 55000, 'outdoor', 'active'),
    (3, 'Bayfront Concert Hall', 'Singapore', 'Singapore', 2400, 'indoor', 'active'),
    (4, 'Sentosa Open Air', 'Singapore', 'Singapore', 18000, 'outdoor', 'active'),
    (5, 'Clarke Quay Live House', 'Singapore', 'Singapore', 900, 'indoor', 'active'),
    (6, 'Jurong Festival Grounds', 'Singapore', 'Singapore', 30000, 'outdoor', 'active');

-- =============================================================================
-- 4. SEED: events (matches EVENTS in catalog.ts; organizer is the seeded
--    system-organiser customer until a real signed-in organiser creates one)
-- =============================================================================

INSERT INTO events (event_id, event_name, event_type, venue_id, organizer_id, event_start_datetime, event_end_datetime, status, total_capacity, featured, banner_image_url) VALUES
    (1, 'Neon Skyline Tour', 'concert', 1, 1, '2026-09-12 20:00:00', '2026-09-12 23:00:00', 'published', 12000, TRUE, 'images/hero-concert.jpg'),
    (2, 'ASEAN Cup Final', 'sports', 2, 1, '2026-09-28 17:00:00', '2026-09-28 19:30:00', 'published', 55000, TRUE, 'images/hero-stadium.jpg'),
    (3, 'Midnight at the Esplanade', 'theater', 3, 1, '2026-10-10 20:30:00', '2026-10-10 22:30:00', 'published', 2400, TRUE, 'images/hero-theatre.jpg'),
    (4, 'Marina Jazz Nights', 'concert', 5, 1, '2026-09-19 19:30:00', '2026-09-19 22:00:00', 'published', 900, FALSE, 'images/venue-livehouse.jpg'),
    (5, 'Indie Weekender', 'concert', 4, 1, '2026-10-04 18:00:00', '2026-10-04 23:00:00', 'published', 18000, FALSE, 'images/venue-openair.jpg'),
    (6, 'Island Derby', 'sports', 2, 1, '2026-10-17 19:45:00', '2026-10-17 21:45:00', 'published', 55000, FALSE, 'images/venue-stadium.jpg'),
    (7, 'Late Night Improv', 'theater', 5, 1, '2026-10-23 22:00:00', '2026-10-23 23:30:00', 'published', 900, FALSE, 'images/venue-theatre.jpg'),
    (8, 'Harbour Lights Festival', 'concert', 6, 1, '2026-10-31 16:00:00', '2026-10-31 23:59:00', 'published', 30000, FALSE, 'images/venue-festival.jpg');

-- =============================================================================
-- 5. SEED: ticket_types (matches TICKETS in catalog.ts — one row per section)
-- =============================================================================

INSERT INTO ticket_types (ticket_type_id, event_id, type_name, price, quantity_total, quantity_available, quantity_sold, sale_start_datetime, sale_end_datetime, status, seating_section) VALUES
    (1, 1, 'Cat 1 — Floor', 188.00, 250, 64,  186, '2026-06-01 00:00:00', '2026-09-12 18:00:00', 'active', 'Cat 1 — Floor'),
    (2, 1, 'General Admission', 88.00, 400, 250, 150, '2026-06-01 00:00:00', '2026-09-12 18:00:00', 'active', 'General Admission'),
    (3, 4, 'Stalls', 120.00, 120, 22,  98,  '2026-06-01 00:00:00', '2026-09-19 18:00:00', 'active', 'Stalls'),
    (4, 2, 'North Stand', 250.00, 5000, 1580, 3420, '2026-06-01 00:00:00', '2026-09-28 15:00:00', 'active', 'North Stand'),
    (5, 5, 'General Admission', 95.00, 600, 0,   600, '2026-06-01 00:00:00', '2026-10-04 16:00:00', 'sold_out', 'General Admission'),
    (6, 3, 'Circle', 210.00, 340, 28,  312, '2026-06-01 00:00:00', '2026-10-10 18:30:00', 'active', 'Circle'),
    (7, 6, 'West Grandstand', 78.00, 5000, 2900, 2100, '2026-06-01 00:00:00', '2026-10-17 17:45:00', 'active', 'West Grandstand'),
    (8, 7, 'Standing', 45.00, 150, 86,  64,  '2026-06-01 00:00:00', '2026-10-23 20:00:00', 'active', 'Standing'),
    (9, 8, 'General Admission', 130.00, 800, 390, 410, '2026-06-01 00:00:00', '2026-10-31 14:00:00', 'active', 'General Admission');

-- =============================================================================
-- 6. SEED: orders, order_items, tickets — enough purchases to populate the
--    Sales and Attendees pages for a few events
-- =============================================================================

INSERT INTO orders (order_id, order_number, customer_id, event_id, order_status, payment_status, total_amount, final_amount, currency, billing_email, created_at) VALUES
    (1, 'ONE-1001', 2, 1, 'completed', 'paid', 376.00, 376.00, 'SGD', 'amanda.lim@example.com', '2026-08-02 10:15:00'),
    (2, 'ONE-1002', 3, 1, 'completed', 'paid', 188.00, 188.00, 'SGD', 'rachel.tan@example.com', '2026-08-03 09:40:00'),
    (3, 'ONE-1003', 4, 1, 'completed', 'paid', 352.00, 352.00, 'SGD', 'weijie.koh@example.com', '2026-08-05 14:22:00'),
    (4, 'ONE-1004', 5, 4, 'completed', 'paid', 120.00, 120.00, 'SGD', 'nur.aisyah@example.com', '2026-08-07 11:05:00'),
    (5, 'ONE-1005', 6, 2, 'completed', 'paid', 500.00, 500.00, 'SGD', 'marcus.ong@example.com', '2026-08-10 16:48:00'),
    (6, 'ONE-1006', 7, 1, 'completed', 'paid', 264.00, 264.00, 'SGD', 'priya.sharma@example.com', '2026-08-12 13:30:00');

INSERT INTO order_items (order_id, ticket_type_id, quantity, unit_price, subtotal) VALUES
    (1, 2, 1, 88.00, 88.00),
    (1, 1, 1, 188.00, 188.00),
    (1, 1, 1, 100.00, 100.00), -- a second Cat 1 seat bought at an earlier presale price
    (2, 1, 1, 188.00, 188.00),
    (3, 2, 4, 88.00, 352.00),
    (4, 3, 1, 120.00, 120.00),
    (5, 4, 2, 250.00, 500.00),
    (6, 2, 3, 88.00, 264.00);

INSERT INTO tickets (ticket_uuid, event_id, ticket_type_id, order_id, customer_id, ticket_code, status, price_paid, issued_at) VALUES
    (UUID(), 1, 2, 1, 2, 'TKT-1001', 'sold', 88.00, '2026-08-02 10:15:00'),
    (UUID(), 1, 1, 2, 3, 'TKT-1002', 'sold', 188.00, '2026-08-03 09:40:00'),
    (UUID(), 1, 2, 3, 4, 'TKT-1003', 'sold', 88.00, '2026-08-05 14:22:00'),
    (UUID(), 4, 3, 4, 5, 'TKT-1004', 'sold', 120.00, '2026-08-07 11:05:00'),
    (UUID(), 2, 4, 5, 6, 'TKT-1005', 'sold', 250.00, '2026-08-10 16:48:00'),
    (UUID(), 1, 2, 6, 7, 'TKT-1006', 'sold', 88.00, '2026-08-12 13:30:00');

-- =============================================================================
-- 7. SEED: customer_event_roles — the system organiser is Admin on every
--    event it created, and Jamie is a door Helper on the first one
-- =============================================================================

INSERT INTO customer_event_roles (customer_id, event_id, role_id, added_by_customer_id) VALUES
    (1, 1, 1, 1), (1, 2, 1, 1), (1, 3, 1, 1), (1, 4, 1, 1),
    (1, 5, 1, 1), (1, 6, 1, 1), (1, 7, 1, 1), (1, 8, 1, 1),
    (8, 1, 3, 1),
    (2, 1, 2, NULL), (3, 1, 2, NULL), (4, 1, 2, NULL),
    (5, 4, 2, NULL), (6, 2, 2, NULL), (7, 1, 2, NULL);
