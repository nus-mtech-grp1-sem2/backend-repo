# OneStage backend

## Local login and event roles

The current Event/Ticket services enforce roles from
`event_inventory.event_team_memberships`. The new Authorization service is an
isolated foundation: starting or seeding it does **not** switch existing APIs.
Customer is baseline access; Organiser and Helper are event-specific assignments.
Cognito authenticates users and issues access tokens; Cognito groups do not grant
these event permissions.

### Existing application login

1. Install dependencies with `npm ci`. Configure your untracked `.env` with a
   reachable MySQL host, database credentials, `DB_SSL=false` for local MySQL,
   `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, and AWS region. Event user search
   and invitations also require AWS credentials with the relevant Cognito admin
   permissions; use your normal credential flow and never commit credentials.
2. Start the backend with `npm run dev`. Compose currently expects an external
   MySQL instance; it does not define a MySQL container. Use a disposable local
   database, not the shared AWS database, for these tests. Apply the existing
   `database/02` schema and only follow-up scripts needed by your database after
   inspecting them. Some later scripts assume infrastructure-specific accounts.
3. In the separately managed frontend checkout, run its existing `npm start` and
   open `http://localhost:4200`. Use Login or Register to enter Cognito Managed
   Login. The configured Cognito client must allow the localhost callback URL.
4. After redirect, confirm authenticated state and a protected API request in
   browser Network tools. Its Authorization header must contain an **access
   token**, not an ID token. Do not paste tokens into tickets, logs, or chat.

### Existing role flows

Use three test accounts and two events. An authenticated account can create an
 event; creation establishes its organiser membership. Through the organiser UI,
invite a second account as Helper and a third as Organiser. Accept the invitation
as the invited account. Pending/rejected invitations must not grant event access.

| Check | Expected |
|---|---|
| Signed-out protected request | 401 |
| Customer browsing public events | Allowed |
| Customer managing another account's event | 403 |
| Accepted Organiser managing assigned event | Allowed |
| Accepted Helper checking in assigned event's ticket | Allowed |
| Helper changing event details | 403 |
| Helper checking in an unassigned event | 403 |
| Pending/rejected or removed membership | 403 |
| Scan the same issued ticket twice | VALID, then ALREADY_USED |

The browser workspace guard checks sign-in only; API responses enforce event
permissions. Existing team removal deletes a legacy row. The new schema preserves
revocation history, but that behavior is not yet wired into current APIs.

### Isolated Authorization service

Use a disposable MySQL 8 database. The additive script below creates only the new
schema and does not copy existing memberships. Replace the connection options
with your **local** database settings; `-p` prompts instead of exposing passwords:

```sh
mysql -h 127.0.0.1 -P 3306 -u root -p < database/09-add-authorization-schema.sql
```

Create a dedicated local reader using a disposable password through an interactive
MySQL session. Grant `SELECT` on `authorization.users` and
`authorization.event_role_assignments` only. Runtime `/authorize` requires no
write grants. Future mutation adapters will require a separate reviewed writer.

Configure `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_SSL`, Cognito identifiers, and
`AUTHORIZATION_SERVICE_TOKEN` (at least 32 random characters) in the untracked
`.env`. Start with `npm run dev:authorization` (default loopback port 3008).
Alternatively use `npm run dev -- --profile authorization`; the profile uses
`AUTHORIZATION_DB_USER` and `AUTHORIZATION_DB_PASSWORD`, exposes port 3008 only
on loopback, and does not route Authorization through Kong. Ordinary startup
remains unchanged.

Seed users with the exact Cognito issuer and immutable `sub` from test accounts.
In an interactive **local** MySQL session, substitute test-account identities:

```sql
USE authorization;
INSERT INTO users (issuer,cognito_sub)
VALUES ('https://cognito-idp.REGION.amazonaws.com/POOL_ID','TEST_ACCOUNT_SUB');
INSERT INTO event_role_assignments
(user_id,event_id,role,is_owner,granted_by_sub)
SELECT user_id,101,'organizer',TRUE,cognito_sub FROM users
WHERE cognito_sub='TEST_ACCOUNT_SUB';
```

For a Helper account, insert its user and an `event_helper` assignment with
`is_owner=FALSE`. A Customer has a user row but no event assignments. Use event 102
for isolation checks. These seeds apply only to Authorization's isolated tests.

In a private shell, supply the service credential and a current browser access
token without embedding either in shell history:

```sh
read -r -s AUTHZ_WORKLOAD_TOKEN
read -r -s COGNITO_ACCESS_TOKEN
export AUTHZ_WORKLOAD_TOKEN COGNITO_ACCESS_TOKEN
python3 - <<'PY'
import json, os, urllib.request, urllib.error
request = urllib.request.Request('http://127.0.0.1:3008/authorize',
    data=json.dumps({'action':'ticket.checkin','eventId':101}).encode(),
    headers={'Content-Type':'application/json',
             'Authorization':'Bearer '+os.environ['COGNITO_ACCESS_TOKEN'],
             'X-Service-Token':os.environ['AUTHZ_WORKLOAD_TOKEN']})
try:
    with urllib.request.urlopen(request, timeout=2) as response:
        print(response.status, response.read().decode())
except urllib.error.HTTPError as error:
    print(error.code, error.read().decode())
PY
unset AUTHZ_WORKLOAD_TOKEN COGNITO_ACCESS_TOKEN
```

Test the matrix above against `/authorize`, using `event.update`,
`event.team.revoke-organizer`, and `ticket.checkin`. `event.create` takes no
`eventId` and permits authenticated baseline users. Unknown actions, invalid event
IDs, or extra identity fields return 400. Bad workload credentials or invalid
Cognito tokens return 401. Missing assignments return 403.

For revocation, locally update an assignment to `status='REVOKED'` and set revoke
actor/time; the next decision returns 403. A pending invitation without an active
assignment also returns 403. This direct SQL is a local test fixture, not a
production role-management procedure. Lifecycle helpers are internal foundations;
public mutation adapters/backfill are later work.

With MySQL unavailable, event-specific decisions return 503. With Authorization
stopped, direct requests fail to connect; **current Event/Ticket APIs remain
independent**. After future cutover, those APIs must return 503 when Authorization
is unavailable.

### Verification and limitations

```sh
npm run test:authorization
npm test -w services/ticket
npx --no-install tsc --noEmit
```

Application tests use controlled fixtures and locally signed tokens to check
signature, issuer, client, expiry, and token type without contacting Cognito.
Real hosted-login integration still requires the manual Cognito flow.
Review `services/authorization/openapi/openapi.json` for the internal contract.
Shared workload credentials are an initial internal mechanism: require protected
transport, secure storage and rotation before deployment; never send them from
browser code. No deployment wiring or production grants are included.

The schema is additive/replayable but does not reconcile a divergent existing
schema. Validate DDL, lifecycle concurrency, and recovery on compatible disposable
MySQL before production use. Never reset database volumes to test this change.

## Shared protected-handler helper

The `@onestage/authorization-client` workspace provides a helper for later Event
and Ticket integration. No current handler has been switched. When adopting it,
add `"@onestage/authorization-client": "1.0.0"` to that service's dependencies and
refresh the root lockfile. Configure once after loading the service environment:

```ts
import { createAuthorizationGuard } from '@onestage/authorization-client';

const requireAuthorization = createAuthorizationGuard({
  url: process.env.AUTHORIZATION_URL!,
  serviceToken: process.env.AUTHORIZATION_SERVICE_TOKEN!,
});

// Within a protected Express handler, after parsing/validating the event ID:
if (!(await requireAuthorization(req, res, 'ticket.checkin', eventId))) return;
```

Use `http://127.0.0.1:3008/authorize` for host-local testing or
`http://authorization:3008/authorize` inside the Compose network. Remote production
transport must protect the token and workload credential. Supply the original
caller token unchanged and choose the action in server code. For baseline event
creation, call with `event.create` and omit event ID.

The helper returns true only for a valid allow response. Otherwise it sends the
response and returns false: 401 for a missing/invalid caller token, 403 for explicit
denial, and 503 for timeout, bad workload credentials, invalid responses, or
unavailable dependencies. The total outbound deadline (including response reading)
defaults to 500 ms; override with `timeoutMs` after measuring the environment.
No retries, redirects, positive caching, or permissive fallback. Forwarded request
IDs support correlation. Domain-specific business constraints still belong to the
handler; this helper checks authorization only.

Test the helper/producer integration without MySQL or Cognito:

```sh
npm run test:authorization-client
```
