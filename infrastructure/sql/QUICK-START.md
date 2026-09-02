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
