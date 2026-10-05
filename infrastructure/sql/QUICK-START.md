# OneStage Database Quick Start

The authoritative MySQL schema is in [`../../database/02-init-create-tables-index.sql`](../../database/02-init-create-tables-index.sql). It creates the four service-owned schemas:

- `event_inventory`
- `queue`
- `checkout`
- `ticketing`

## New database

Run the base schema once against an empty MySQL instance:

```powershell
Get-Content ..\..\database\02-init-create-tables-index.sql | mysql -h $env:DB_HOST -P $env:DB_PORT -u $env:DB_USER -p $env:DB_NAME_EVENT_INVENTORY
```

The script creates the databases itself, so `DB_NAME_EVENT_INVENTORY` is only the initial connection schema.

## AWS: grant the app user access to all four schemas (one-time)

On the ECS-hosted MySQL instance, the app user (`onestage_app`, from `infrastructure/terraform/secrets.tf`) is auto-created by the MySQL container's startup with privileges on the `onestage` database only — it has no access to `event_inventory`, `queue`, `checkout`, or `ticketing` until this runs. Skip this step for a local MySQL container where you're already connecting as an account with full privileges.

Run once, as **root** (the app user cannot grant itself access):

```powershell
Get-Content ..\..\database\05-grant-onestage-app-schema-access.sql | mysql -h $env:DB_HOST -P $env:DB_PORT -u root -p
```

Safe to re-run — `GRANT` is idempotent.

## Existing database upgrades

Run these once, in numeric order, only when upgrading a schema created before the fields existed. Each filename's number reflects when it was written, so this is also the safe apply order:

```powershell
Get-Content ..\..\database\03-add-event-team-invitations.sql | mysql -h $env:DB_HOST -P $env:DB_PORT -u $env:DB_USER -p $env:DB_NAME_EVENT_INVENTORY
Get-Content ..\..\database\04-add-event-total-seats.sql | mysql -h $env:DB_HOST -P $env:DB_PORT -u $env:DB_USER -p $env:DB_NAME_EVENT_INVENTORY
Get-Content ..\..\database\06-add-notification-schema.sql | mysql -h $env:DB_HOST -P $env:DB_PORT -u $env:DB_USER -p $env:DB_NAME_NOTIFICATION
Get-Content ..\..\database\05-grant-onestage-app-schema-access.sql | mysql -h $env:DB_HOST -P $env:DB_PORT -u root -p
Get-Content ..\..\database\07-add-queue-order-idempotency.sql | mysql -h $env:DB_HOST -P $env:DB_PORT -u $env:DB_USER -p $env:DB_NAME_QUEUE
Get-Content ..\..\database\08-ticket-checkin-attempts.sql | mysql -h $env:DB_HOST -P $env:DB_PORT -u $env:DB_USER -p $env:DB_NAME_TICKETING
Get-Content ..\..\database\09-add-customer-name.sql | mysql -h $env:DB_HOST -P $env:DB_PORT -u $env:DB_USER -p $env:DB_NAME_CHECKOUT
Get-Content ..\..\database\10-add-event-available-buyers.sql | mysql -h $env:DB_HOST -P $env:DB_PORT -u $env:DB_USER -p $env:DB_NAME_EVENT_INVENTORY
Get-Content ..\..\database\11-add-inventory-layout.sql | mysql -h $env:DB_HOST -P $env:DB_PORT -u $env:DB_USER -p $env:DB_NAME_EVENT_INVENTORY
Get-Content ..\..\database\12-add-event-image-and-seat-tags.sql | mysql -h $env:DB_HOST -P $env:DB_PORT -u $env:DB_USER -p $env:DB_NAME_EVENT_INVENTORY
Get-Content ..\..\database\13-add-inventory-grid-position.sql | mysql -h $env:DB_HOST -P $env:DB_PORT -u $env:DB_USER -p $env:DB_NAME_EVENT_INVENTORY
Get-Content ..\..\database\14-add-grid-customization.sql | mysql -h $env:DB_HOST -P $env:DB_PORT -u $env:DB_USER -p $env:DB_NAME_EVENT_INVENTORY
Get-Content ..\..\database\15-email-notifications-per-ticket.sql | mysql -h $env:DB_HOST -P $env:DB_PORT -u $env:DB_USER -p $env:DB_NAME_NOTIFICATION
Get-Content ..\..\database\17-add-event-team-soft-revoke.sql | mysql -h $env:DB_HOST -P $env:DB_PORT -u $env:DB_USER -p $env:DB_NAME_EVENT_INVENTORY
```

- `03-add-event-team-invitations.sql` adds invitation status and response tracking to `event_inventory.event_team_memberships`.
- `04-add-event-total-seats.sql` adds the event capacity column with a default of `1` for existing events.
- `06-add-notification-schema.sql` creates the `notification` database and `email_notifications` table. Re-run `05-grant-onestage-app-schema-access.sql` afterward so `onestage_app` can reach it.
- `07-add-queue-order-idempotency.sql` adds unique event-session and hold-order keys so queue configuration and order creation are idempotent.
- `08-ticket-checkin-attempts.sql` adds check-in audit logging support.
- `09-add-customer-name.sql` preserves the attendee display name for helper lookup and organiser rosters.
- `10-add-event-available-buyers.sql` adds the nullable concurrent-buyer limit and its capacity check.
- `11-add-inventory-layout.sql` adds `inventory_items.section_code`/`layout_config` and `seats.row_label`/`seat_number`/`pos_x`/`pos_y`, used by the organiser inventory/seat-map configuration UI.
- `12-add-event-image-and-seat-tags.sql` adds the event photo, per-zone colour, and seat tag columns (rollback: `12-add-event-image-and-seat-tags.rollback.sql`).
- `13-add-inventory-grid-position.sql` adds a virtual row/column position per zone/section for the drag-and-drop venue map.
- `14-add-grid-customization.sql` adds a per-event custom grid size and multi-cell zone/section spans.
- `15-email-notifications-per-ticket.sql` moves `email_notifications` from one row per order to one row per ticket.
- `17-add-event-team-soft-revoke.sql` keeps removed team members as `REVOKED` rows with `revoked_at`/`revoked_by_sub`, instead of deleting them. Apply before deploying the event service that uses it.

Do not rerun an upgrade after it has been applied: MySQL will reject a duplicate column or index.

## Verify

```sql
USE event_inventory;
SHOW TABLES;
DESCRIBE events;
DESCRIBE event_team_memberships;
```

See the [Persistence Design](https://github.com/nus-mtech-grp1-sem2/docs/blob/main/architecture/04-persistence-design.md) in the `docs` repository for schema ownership across the services, and [`infrastructure/docker-compose.yml`](../docker-compose.yml) for the local MySQL container.
