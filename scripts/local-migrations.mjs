// The migrations that build a fresh local or CI database, in the order they run.
// Both scripts/initialize-test-db.mjs and the MySQL init mounts in
// infrastructure/docker-compose.override.yml must apply exactly this list;
// scripts/local-migrations.test.mjs fails when they drift apart.
export const localMigrations = [
  '02-init-create-tables-index.sql',
  '06-add-notification-schema.sql',
  '08-ticket-checkin-attempts.sql',
  '09-add-customer-name.sql',
  '15-email-notifications-per-ticket.sql',
  '11-add-inventory-layout.sql',
  '12-add-event-image-and-seat-tags.sql',
  '13-add-inventory-grid-position.sql',
  '14-add-grid-customization.sql',
  '16-add-event-cancellation-notification-type.sql',
  '17-add-event-team-soft-revoke.sql',
  '18-add-ga-section-seat-numbers.sql',
  '19-backfill-ga-section-seat-numbers.sql',
  '20-add-queue-position-counters.sql',
];

// Files in database/ that a fresh database must not run, and why.
export const skippedMigrations = {
  '03-add-event-team-invitations.sql': 'already part of 02-init-create-tables-index.sql',
  '04-add-event-total-seats.sql': 'already part of 02-init-create-tables-index.sql',
  '05-grant-onestage-app-schema-access.sql': 'grants for the deployed onestage_app user only',
  '07-add-queue-order-idempotency.sql': 'already part of 02-init-create-tables-index.sql',
  '10-add-event-available-buyers.sql': 'already part of 02-init-create-tables-index.sql',
  '12-add-event-image-and-seat-tags.rollback.sql': 'rollback script, not a forward migration',
};
