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

Run these once, in order, only when upgrading a schema created before the fields existed:

```powershell
Get-Content ..\..\database\03-add-event-team-invitations.sql | mysql -h $env:DB_HOST -P $env:DB_PORT -u $env:DB_USER -p $env:DB_NAME_EVENT_INVENTORY
Get-Content ..\..\database\04-add-event-total-seats.sql | mysql -h $env:DB_HOST -P $env:DB_PORT -u $env:DB_USER -p $env:DB_NAME_EVENT_INVENTORY
```

- `03-add-event-team-invitations.sql` adds invitation status and response tracking to `event_inventory.event_team_memberships`.
- `04-add-event-total-seats.sql` adds the event capacity column with a default of `1` for existing events.

Do not rerun an upgrade after it has been applied: MySQL will reject a duplicate column or index.

## Verify

```sql
USE event_inventory;
SHOW TABLES;
DESCRIBE events;
DESCRIBE event_team_memberships;
```

See [`database/onestage-system-design.md`](../../database/onestage-system-design.md) for schema ownership across the four services, and [`infrastructure/docker-compose.yml`](../docker-compose.yml) for the local MySQL container.
