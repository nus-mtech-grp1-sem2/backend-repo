-- Apply once to existing event_inventory schemas created before invitations.
USE event_inventory;

ALTER TABLE event_team_memberships
  ADD COLUMN invite_status ENUM('PENDING', 'ACCEPTED', 'REJECTED') NOT NULL DEFAULT 'ACCEPTED' AFTER role,
  ADD COLUMN responded_at DATETIME NULL AFTER granted_at;

CREATE INDEX idx_event_team_invitation ON event_team_memberships (user_sub, invite_status);