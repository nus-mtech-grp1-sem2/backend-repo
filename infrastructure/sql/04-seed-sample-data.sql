-- Sample data for local development, across the four schemas
-- `02-create-all-tables.sql` creates. Mirrors the event/venue set the old
-- single-schema seed (infrastructure/sql/03-event-roles-and-seed.sql,
-- removed by this migration) used to carry: 8 events across 6 venues.
--
-- Identity in this schema is entirely the Cognito `sub` — there is no local
-- customers table. Seeded event ownership is assigned to the development
-- account foochuanyong@gmail.com
-- (sub f91a054c-a051-7081-9518-09e2e1ebed25). Checkout orders and their
-- tickets retain varied sample buyers so attendee and sales views remain
-- useful without flooding that development account's "My events" page.
-- Event artwork is binary and lives in local-mysql/seed-images.mts instead.

USE onestagedb;

INSERT INTO events (event_id, organiser_sub, title, description, venue, starts_at, total_seats, tier, status) VALUES
  (1, 'f91a054c-a051-7081-9518-09e2e1ebed25', 'Neon Skyline Tour', 'An arena show touring the region.', 'Marina Bay Arena', '2026-09-12 20:00:00', 500, 'TIER1_GA', 'PUBLISHED'),
  (2, 'f91a054c-a051-7081-9518-09e2e1ebed25', 'ASEAN Cup Final', 'The regional football final.', 'Kallang Grand Stadium', '2026-09-28 17:00:00', 2000, 'TIER1_GA', 'PUBLISHED'),
  (3, 'f91a054c-a051-7081-9518-09e2e1ebed25', 'Midnight at the Esplanade', 'A one-night theatre performance with reserved seating.', 'Bayfront Concert Hall', '2026-10-10 20:30:00', 40, 'TIER2_SEATED', 'PUBLISHED'),
  (4, 'f91a054c-a051-7081-9518-09e2e1ebed25', 'Marina Jazz Nights', 'An intimate live-house jazz set.', 'Clarke Quay Live House', '2026-09-19 19:30:00', 300, 'TIER1_GA', 'PUBLISHED'),
  (5, 'f91a054c-a051-7081-9518-09e2e1ebed25', 'Indie Weekender', 'An open-air weekend of indie acts.', 'Sentosa Open Air', '2026-10-04 18:00:00', 300, 'TIER1_GA', 'PUBLISHED'),
  (6, 'f91a054c-a051-7081-9518-09e2e1ebed25', 'Island Derby', 'A local rivalry match.', 'Kallang Grand Stadium', '2026-10-17 19:45:00', 1500, 'TIER1_GA', 'PUBLISHED'),
  (7, 'f91a054c-a051-7081-9518-09e2e1ebed25', 'Late Night Improv', 'A late-night reserved-seating comedy show.', 'Clarke Quay Live House', '2026-10-23 22:00:00', 30, 'TIER2_SEATED', 'PUBLISHED'),
  (8, 'f91a054c-a051-7081-9518-09e2e1ebed25', 'Harbour Lights Festival', 'A festival-grounds showcase to close out the season.', 'Jurong Festival Grounds', '2026-10-31 16:00:00', 800, 'TIER1_GA', 'PUBLISHED');

INSERT INTO inventory_items (event_id, name, total_qty, price_cents) VALUES
  (1, 'General Admission', 500, 8800),
  (2, 'General Admission', 2000, 4500),
  (3, 'Reserved Seating', 40, 6500),
  (4, 'General Admission', 300, 6000),
  (5, 'General Admission', 300, 9500),
  (6, 'General Admission', 1500, 7800),
  (7, 'Reserved Seating', 30, 4500),
  (8, 'General Admission', 800, 13000);

-- Seats for the two TIER2_SEATED events (3 and 7): 5 rows x 8 seats, and
-- 5 rows x 6 seats respectively.
INSERT INTO seats (event_id, inventory_item_id, seat_label)
SELECT 3, (SELECT inventory_item_id FROM inventory_items WHERE event_id = 3 LIMIT 1),
       CONCAT(CHAR(64 + row_num), col_num)
FROM (
  SELECT a.n AS row_num, b.n AS col_num
  FROM (SELECT 1 n UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5) a
  CROSS JOIN (SELECT 1 n UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8) b
) seat_grid;

INSERT INTO seats (event_id, inventory_item_id, seat_label)
SELECT 7, (SELECT inventory_item_id FROM inventory_items WHERE event_id = 7 LIMIT 1),
       CONCAT(CHAR(64 + row_num), col_num)
FROM (
  SELECT a.n AS row_num, b.n AS col_num
  FROM (SELECT 1 n UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5) a
  CROSS JOIN (SELECT 1 n UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6) b
) seat_grid;

INSERT INTO event_team_memberships (event_id, user_sub, user_email, role, invite_status, granted_by_sub)
SELECT event_id, 'f91a054c-a051-7081-9518-09e2e1ebed25', 'foochuanyong@gmail.com', 'ORGANISER', 'ACCEPTED', 'f91a054c-a051-7081-9518-09e2e1ebed25'
FROM events;

INSERT INTO event_team_memberships
  (event_id, user_sub, user_email, role, invite_status, granted_by_sub, responded_at)
VALUES
  (1, '00000000-0000-0000-0000-000000000101', 'helper@example.com', 'HELPER', 'ACCEPTED', 'f91a054c-a051-7081-9518-09e2e1ebed25', '2026-08-20 10:00:00'),
  (2, '00000000-0000-0000-0000-000000000101', 'helper@example.com', 'HELPER', 'ACCEPTED', 'f91a054c-a051-7081-9518-09e2e1ebed25', '2026-08-20 10:05:00'),
  (3, '00000000-0000-0000-0000-000000000102', 'usher@example.com', 'HELPER', 'PENDING', 'f91a054c-a051-7081-9518-09e2e1ebed25', NULL);

-- Synchronise availability with the paid orders below. Event 2 has a large
-- active reservation so it shows as "Few left"; event 7 is sold out.
UPDATE inventory_items SET sold_qty = 8 WHERE event_id = 1;
UPDATE inventory_items SET reserved_qty = 1600, sold_qty = 120 WHERE event_id = 2;
UPDATE inventory_items SET sold_qty = 4 WHERE event_id = 3;
UPDATE inventory_items SET sold_qty = 5 WHERE event_id = 4;
UPDATE inventory_items SET sold_qty = 3 WHERE event_id = 5;
UPDATE inventory_items SET sold_qty = 2 WHERE event_id = 6;
UPDATE inventory_items SET sold_qty = 30 WHERE event_id = 7;
UPDATE inventory_items SET sold_qty = 6 WHERE event_id = 8;

UPDATE seats SET status = 'SOLD'
WHERE event_id = 3 AND seat_label IN ('A1', 'A2', 'B3', 'B4');
UPDATE seats SET status = 'SOLD' WHERE event_id = 7;

INSERT INTO inventory_holds
  (hold_id, event_id, inventory_item_id, customer_sub, quantity, status, order_id, expires_at, created_at)
VALUES
  (1, 1, (SELECT inventory_item_id FROM inventory_items WHERE event_id = 1 LIMIT 1), '00000000-0000-0000-0000-000000000201', 2, 'CONFIRMED', 1, '2026-08-26 12:15:00', '2026-08-26 12:00:00'),
  (2, 3, (SELECT inventory_item_id FROM inventory_items WHERE event_id = 3 LIMIT 1), '00000000-0000-0000-0000-000000000203', 2, 'CONFIRMED', 4, '2026-08-29 15:15:00', '2026-08-29 15:00:00'),
  (3, 7, (SELECT inventory_item_id FROM inventory_items WHERE event_id = 7 LIMIT 1), '00000000-0000-0000-0000-000000000207', 20, 'CONFIRMED', 9, '2026-09-01 09:15:00', '2026-09-01 09:00:00'),
  (4, 2, (SELECT inventory_item_id FROM inventory_items WHERE event_id = 2 LIMIT 1), '00000000-0000-0000-0000-000000000209', 1600, 'ACTIVE', NULL, '2026-09-28 16:30:00', '2026-09-03 09:00:00');

USE `queue`;

INSERT INTO queue_sessions
  (queue_session_id, event_id, opens_at, admission_batch_size, admission_interval_sec, status)
VALUES
  (1, 1, '2026-08-26 11:45:00', 100, 30, 'DRAINED'),
  (2, 2, '2026-09-03 08:45:00', 250, 30, 'OPEN'),
  (3, 3, '2026-08-29 14:45:00', 20, 60, 'DRAINED'),
  (4, 7, '2026-09-01 08:45:00', 20, 60, 'DRAINED'),
  (5, 8, '2026-09-02 17:45:00', 100, 30, 'DRAINED');

INSERT INTO queue_entries
  (queue_session_id, customer_sub, position, status, joined_at, admitted_at, admission_token, token_expires_at)
VALUES
  (1, '00000000-0000-0000-0000-000000000201', 1, 'IN_CHECKOUT', '2026-08-26 11:50:00', '2026-08-26 11:55:00', 'seed-admission-001', '2026-08-26 12:25:00'),
  (2, '00000000-0000-0000-0000-000000000202', 7, 'IN_CHECKOUT', '2026-09-03 08:50:00', '2026-09-03 08:55:00', 'seed-admission-002', '2026-09-03 09:25:00'),
  (2, '00000000-0000-0000-0000-000000000209', 8, 'WAITING', '2026-09-03 08:51:00', NULL, NULL, NULL),
  (3, '00000000-0000-0000-0000-000000000203', 2, 'IN_CHECKOUT', '2026-08-29 14:50:00', '2026-08-29 14:55:00', 'seed-admission-003', '2026-08-29 15:25:00'),
  (4, '00000000-0000-0000-0000-000000000207', 1, 'IN_CHECKOUT', '2026-09-01 08:50:00', '2026-09-01 08:55:00', 'seed-admission-004', '2026-09-01 09:25:00'),
  (5, '00000000-0000-0000-0000-000000000208', 4, 'IN_CHECKOUT', '2026-09-02 17:50:00', '2026-09-02 17:55:00', 'seed-admission-005', '2026-09-02 18:25:00');

USE checkout;

INSERT INTO orders
  (order_id, event_id, customer_sub, customer_email, hold_id, status, total_amount_cents, currency, created_at, paid_at)
VALUES
  (1, 1, '00000000-0000-0000-0000-000000000201', 'alex.tan@example.com', 1, 'PAID', 17600, 'SGD', '2026-08-26 12:00:00', '2026-08-26 12:02:00'),
  (2, 1, '00000000-0000-0000-0000-000000000202', 'jamie.lee@example.com', NULL, 'PAID', 26400, 'SGD', '2026-08-27 09:00:00', '2026-08-27 09:01:00'),
  (3, 1, '00000000-0000-0000-0000-000000000203', 'priya.nair@example.com', NULL, 'PAID', 26400, 'SGD', '2026-08-28 18:30:00', '2026-08-28 18:32:00'),
  (4, 3, '00000000-0000-0000-0000-000000000203', 'priya.nair@example.com', 2, 'PAID', 13000, 'SGD', '2026-08-29 15:00:00', '2026-08-29 15:02:00'),
  (5, 3, '00000000-0000-0000-0000-000000000204', 'daniel.ong@example.com', NULL, 'PAID', 13000, 'SGD', '2026-08-30 11:00:00', '2026-08-30 11:02:00'),
  (6, 4, '00000000-0000-0000-0000-000000000205', 'mei.lim@example.com', NULL, 'PAID', 30000, 'SGD', '2026-08-30 13:00:00', '2026-08-30 13:01:00'),
  (7, 5, '00000000-0000-0000-0000-000000000206', 'sam.wong@example.com', NULL, 'PAID', 28500, 'SGD', '2026-08-31 16:00:00', '2026-08-31 16:03:00'),
  (8, 6, '00000000-0000-0000-0000-000000000201', 'alex.tan@example.com', NULL, 'PAID', 15600, 'SGD', '2026-09-01 08:00:00', '2026-09-01 08:01:00'),
  (9, 7, '00000000-0000-0000-0000-000000000207', 'nur.aisha@example.com', 3, 'PAID', 90000, 'SGD', '2026-09-01 09:00:00', '2026-09-01 09:04:00'),
  (10, 7, '00000000-0000-0000-0000-000000000208', 'chris.goh@example.com', NULL, 'PAID', 45000, 'SGD', '2026-09-01 10:00:00', '2026-09-01 10:02:00'),
  (11, 8, '00000000-0000-0000-0000-000000000208', 'chris.goh@example.com', NULL, 'PAID', 78000, 'SGD', '2026-09-02 18:00:00', '2026-09-02 18:02:00'),
  (12, 2, '00000000-0000-0000-0000-000000000202', 'jamie.lee@example.com', NULL, 'PAID', 540000, 'SGD', '2026-09-03 09:00:00', '2026-09-03 09:05:00');

INSERT INTO order_items
  (order_item_id, order_id, inventory_item_id, seat_id, description, quantity, unit_price_cents)
VALUES
  (1, 1, (SELECT inventory_item_id FROM onestagedb.inventory_items WHERE event_id = 1 LIMIT 1), NULL, 'General Admission', 2, 8800),
  (2, 2, (SELECT inventory_item_id FROM onestagedb.inventory_items WHERE event_id = 1 LIMIT 1), NULL, 'General Admission', 3, 8800),
  (3, 3, (SELECT inventory_item_id FROM onestagedb.inventory_items WHERE event_id = 1 LIMIT 1), NULL, 'General Admission', 3, 8800),
  (4, 4, (SELECT inventory_item_id FROM onestagedb.inventory_items WHERE event_id = 3 LIMIT 1), (SELECT seat_id FROM onestagedb.seats WHERE event_id = 3 AND seat_label = 'A1'), 'Reserved Seating', 1, 6500),
  (5, 4, (SELECT inventory_item_id FROM onestagedb.inventory_items WHERE event_id = 3 LIMIT 1), (SELECT seat_id FROM onestagedb.seats WHERE event_id = 3 AND seat_label = 'A2'), 'Reserved Seating', 1, 6500),
  (6, 5, (SELECT inventory_item_id FROM onestagedb.inventory_items WHERE event_id = 3 LIMIT 1), (SELECT seat_id FROM onestagedb.seats WHERE event_id = 3 AND seat_label = 'B3'), 'Reserved Seating', 1, 6500),
  (7, 5, (SELECT inventory_item_id FROM onestagedb.inventory_items WHERE event_id = 3 LIMIT 1), (SELECT seat_id FROM onestagedb.seats WHERE event_id = 3 AND seat_label = 'B4'), 'Reserved Seating', 1, 6500),
  (8, 6, (SELECT inventory_item_id FROM onestagedb.inventory_items WHERE event_id = 4 LIMIT 1), NULL, 'General Admission', 5, 6000),
  (9, 7, (SELECT inventory_item_id FROM onestagedb.inventory_items WHERE event_id = 5 LIMIT 1), NULL, 'General Admission', 3, 9500),
  (10, 8, (SELECT inventory_item_id FROM onestagedb.inventory_items WHERE event_id = 6 LIMIT 1), NULL, 'General Admission', 2, 7800),
  (11, 11, (SELECT inventory_item_id FROM onestagedb.inventory_items WHERE event_id = 8 LIMIT 1), NULL, 'General Admission', 6, 13000),
  (12, 12, (SELECT inventory_item_id FROM onestagedb.inventory_items WHERE event_id = 2 LIMIT 1), NULL, 'General Admission', 120, 4500);

-- Seated orders contain one item per seat, matching POST /orders behaviour.
INSERT INTO order_items (order_id, inventory_item_id, seat_id, description, quantity, unit_price_cents)
SELECT 9, inventory_item_id, seat_id, 'Reserved Seating', 1, 4500
FROM onestagedb.seats WHERE event_id = 7 ORDER BY seat_id LIMIT 20;

INSERT INTO order_items (order_id, inventory_item_id, seat_id, description, quantity, unit_price_cents)
SELECT 10, inventory_item_id, seat_id, 'Reserved Seating', 1, 4500
FROM onestagedb.seats WHERE event_id = 7 ORDER BY seat_id LIMIT 20, 10;

INSERT INTO payments (order_id, payment_token, status, amount_cents, processed_at)
SELECT order_id, CONCAT('seed-payment-', LPAD(order_id, 3, '0')), 'CAPTURED', total_amount_cents, paid_at
FROM orders WHERE status = 'PAID';

USE ticketing;

-- One ticket per item quantity, exactly as the payment endpoint issues them.
-- The digit cross-join supports quantities up to 999 without relying on
-- MySQL's recursive-CTE depth setting.
INSERT INTO tickets
  (order_id, order_item_id, event_id, customer_sub, customer_email, seat_id, qr_token, status, issued_at)
SELECT oi.order_id, oi.order_item_id, o.event_id, o.customer_sub, o.customer_email,
       oi.seat_id,
       CONCAT('seed-ticket-', LPAD(oi.order_item_id, 3, '0'), '-', LPAD(sequence.n, 4, '0')),
       'ISSUED', o.paid_at
FROM checkout.order_items oi
JOIN checkout.orders o ON o.order_id = oi.order_id
JOIN (
  SELECT ones.n + tens.n * 10 + hundreds.n * 100 + 1 AS n
  FROM
    (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) ones
  CROSS JOIN
    (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) tens
  CROSS JOIN
    (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) hundreds
) AS sequence ON sequence.n <= oi.quantity
WHERE o.status = 'PAID';

-- Successful and duplicate scans populate both the current ticket state and
-- its audit history for the helper dashboard.
UPDATE tickets
SET status = 'CHECKED_IN', checked_in_at = '2026-09-12 19:45:00',
    checked_in_by_sub = '00000000-0000-0000-0000-000000000101'
WHERE qr_token IN ('seed-ticket-001-0001', 'seed-ticket-001-0002');

INSERT INTO check_in_logs (ticket_id, scanned_by_sub, result, scanned_at)
SELECT ticket_id, checked_in_by_sub, 'SUCCESS', checked_in_at
FROM tickets WHERE status = 'CHECKED_IN';

INSERT INTO check_in_logs (ticket_id, scanned_by_sub, result, scanned_at)
SELECT ticket_id, '00000000-0000-0000-0000-000000000101', 'DUPLICATE', '2026-09-12 19:46:00'
FROM tickets WHERE qr_token = 'seed-ticket-001-0001';
