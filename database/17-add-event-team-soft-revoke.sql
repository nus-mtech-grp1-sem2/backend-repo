-- Removing a helper or organiser from an event revokes their membership
-- instead of deleting the row, so the roster keeps a record of who had which
-- role, who granted it, and who removed them when.
--
--   invite_status = 'REVOKED'  the membership is no longer active. Every access
--                              check (event, inventory, queue, order, ticket and
--                              scanner sessions) already requires 'ACCEPTED', so
--                              a revoked member loses access on their next request.
--   revoked_at / revoked_by_sub  when and by whom the membership was most recently
--                              revoked. Re-inviting the person reactivates the
--                              same row (uq_event_team_member stays valid) as
--                              PENDING and leaves these two columns as they were,
--                              so the last removal is still recorded.
--
-- Apply once, after 16-add-event-cancellation-notification-type.sql. Expand
-- only, so the current event service keeps working against the new schema.
-- Appending a value to the end of an ENUM is metadata-only in InnoDB; adding the
-- nullable columns is instant on MySQL 8.0.29+ and an online in-place rebuild
-- before that (the table holds one row per team member, so it is small either
-- way). No GRANT change is needed.
--
-- Deploy this before the event service that revokes instead of deleting. That
-- service writes 'REVOKED' and the new columns, so it fails to remove members
-- until this has run.
USE event_inventory;

ALTER TABLE event_team_memberships
  MODIFY COLUMN invite_status ENUM('PENDING', 'ACCEPTED', 'REJECTED', 'REVOKED') NOT NULL DEFAULT 'ACCEPTED',
  ADD COLUMN revoked_at DATETIME NULL AFTER responded_at,
  ADD COLUMN revoked_by_sub VARCHAR(36) NULL AFTER revoked_at;
