-- Required before deploying the queue and order API implementation to an existing database.
-- Both ALTER statements fail safely if legacy duplicate event sessions or hold orders exist.
-- Inspect and resolve those duplicates before retrying; this migration never deletes data.

ALTER TABLE `queue`.queue_sessions
  ADD UNIQUE KEY uq_queue_sessions_event (event_id);

ALTER TABLE checkout.orders
  ADD UNIQUE KEY uq_orders_hold (hold_id);
