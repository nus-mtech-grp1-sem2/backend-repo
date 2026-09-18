-- Additive foundation only. Never applies itself on service startup.
-- Test on compatible disposable MySQL before execution. Existing tables untouched.
CREATE DATABASE IF NOT EXISTS authorization CHARACTER SET utf8mb4;
USE authorization;
CREATE TABLE IF NOT EXISTS users (
  user_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  issuer VARCHAR(255) NOT NULL,
  cognito_sub VARCHAR(36) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_identity (issuer, cognito_sub)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS event_role_assignments (
  assignment_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  event_id BIGINT UNSIGNED NOT NULL,
  role ENUM('organizer','event_helper') NOT NULL,
  status ENUM('ACTIVE','REVOKED') NOT NULL DEFAULT 'ACTIVE',
  is_owner BOOLEAN NOT NULL DEFAULT FALSE,
  granted_by_sub VARCHAR(36) NOT NULL,
  granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_by_sub VARCHAR(36) NULL,
  revoked_at DATETIME NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  UNIQUE KEY uq_assignment (user_id,event_id,role),
  INDEX idx_event_status (event_id,status),
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  CHECK (is_owner = FALSE OR role = 'organizer')
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS event_role_invitations (
  invitation_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  event_id BIGINT UNSIGNED NOT NULL,
  role ENUM('organizer','event_helper') NOT NULL,
  status ENUM('PENDING','ACCEPTED','REJECTED','REVOKED') NOT NULL DEFAULT 'PENDING',
  invited_by_sub VARCHAR(36) NOT NULL,
  invited_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  responded_at DATETIME NULL,
  INDEX idx_invitee_status (user_id,status),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS audit_records (
  audit_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id VARCHAR(128) NOT NULL,
  actor_sub VARCHAR(36) NOT NULL,
  event_id BIGINT UNSIGNED NOT NULL,
  target_user_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(64) NOT NULL,
  old_state JSON NULL,
  new_state JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_event_time (event_id,created_at)
) ENGINE=InnoDB;
-- No grants, backfill, changes to legacy data, or destructive rollback included.
-- IF NOT EXISTS supports replay but does not reconcile a divergent existing schema.
