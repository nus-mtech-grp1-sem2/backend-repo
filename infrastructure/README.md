# Infrastructure

Everything needed to run the backend locally: the six services plus the Kong
gateway that fronts them.

```
infrastructure/
  docker-compose.yml   the whole stack (6 services + Kong)
  Dockerfile           one image, shared by all six services
  kong/kong.yml        Kong's declarative routing config
```

## Running it

From the **repo root** (not this folder):

```bash
npm run dev     # build + start everything, logs in the foreground
npm run down    # stop and remove the containers
npm run logs    # follow logs (append a service name for just one)
```

Or directly:

```bash
docker compose -f infrastructure/docker-compose.yml up --build
```

## Testing against the shared AWS database

By default `.env`'s `DB_HOST=mysql` points the `auth` service at the local
docker-compose container, isolated per developer. To test against the same
data every developer/production sees, point it at the AWS MySQL task instead:

```bash
npm run db:aws-ip     # prints the mysql Fargate task's current public IP
```

Set `DB_HOST` in `.env` to that IP, and `DB_USER`/`DB_PASSWORD` to the real
AWS Secrets Manager values (ask a teammate — never commit real AWS
credentials). This is a local `.env` change only; nothing in Terraform or
production changes. Fargate assigns a new IP on every task restart, so
re-run `db:aws-ip` if the connection starts failing.

## What the frontend talks to

Only Kong is published to the host, on **http://localhost:8000**. Requests are
routed by path prefix, which Kong strips before forwarding:

| Client request              | Reaches                     |
| --------------------------- | --------------------------- |
| `/api/event/events`         | event service `/events`      |
| `/api/inventory/...`        | inventory service            |
| `/api/queue/...`            | queue service                |
| `/api/order/...`            | order service                |
| `/api/ticket/...`           | ticket service               |
| `/api/notification/...`     | notification service         |

The services themselves are **not** reachable from the host — they only listen
on the internal compose network. To debug one directly, add a `ports:` entry to
it in `docker-compose.yml`.

Kong's admin API is on `127.0.0.1:8001` (loopback only):

```bash
curl http://localhost:8001/routes | jq '.data[].paths'
```

## Adding a service

1. Create `services/<name>` as an npm workspace, listening on the next free port.
2. Add it to `workspaces` in the root `package.json`.
3. Add a block to `docker-compose.yml` (copy an existing one, change `SERVICE`,
   `PORT`, and `container_name`) and add it to Kong's `depends_on`.
4. Add a matching service + route to `kong/kong.yml`, using the compose service
   name as the upstream host.

## Changing Kong's config

`kong/kong.yml` is read at startup only, so after editing it:

```bash
docker compose -f infrastructure/docker-compose.yml restart kong
```

Auth and rate limiting belong here rather than in each service — add the
`key-auth`, `jwt`, or `rate-limiting` plugin to the routes that need it.

## Notes

- **Hot reload works**: `../services` is bind-mounted, and the containers run
  nodemon in polling mode because filesystem events do not cross a Docker
  Desktop bind mount on Windows or macOS.
- **`npm run dev:local`** still runs the six services natively without Docker,
  but then nothing is in front of them — the frontend's `/api` proxy expects
  Kong on port 8000.
