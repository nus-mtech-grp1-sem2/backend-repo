# OneStage k6 test evidence

This suite exercises the deployed public and customer read paths without creating, updating, or deleting application data. It authenticates 22 retained synthetic customers directly against Cognito and executes from the Grafana Cloud Singapore load zone.

## Profiles and cost guardrails

| Profile | Trigger | Shape | Maximum |
|---|---|---|---|
| Deployment | `Deploy backend` workflow dispatch with `run_load_test=true` | 1 → 10 VUs, then 10 → 50 VUs, steady at 50, ramp down; one security probe/second | 50 read VUs, 5 minutes, up to about 4.6 VUh |
| Manual | Grafana Cloud k6 website | 1 → 10 VUs, then 10 → 50 VUs, steady at 50, ramp down; one security probe/second | 50 read VUs, 8.5 minutes, Grafana estimate 7.8 VUh |
| Disposable concurrency | Pull request or manual GitHub Action | 20 VUs race 50 one-ticket holds against 10 tickets | Local CI only, under 30 seconds, no AWS usage |
| B1 queue capacity | Pull request or manual GitHub Action | 100 unique joins from 20 VUs | Disposable full-schema MySQL; no Cognito or AWS |
| B2 checkout capacity | Pull request or manual GitHub Action | Strict 50-order sequential baseline, then a 30-order 3-VU contention probe | Disposable full-schema MySQL; no payment provider, email, ticket service, or AWS |
| B3 payment drain | Pull request or manual GitHub Action | 40 messages through the production serial consumer with 25 ms synthetic processing | In-memory SQS contract; no AWS |
| Mixed queue/checkout | Pull request or manual GitHub Action | 300 joins at 100 VUs, 200 checkouts at 20 VUs, and concurrent admission calls against one event | Disposable full-schema MySQL; all buyers must succeed |
| A concurrent end-to-end | Pull request or manual GitHub Action | 20 queue → admission → seat → order → simulated-payment journeys at 5, 10 and 20 VUs | Separate disposable MySQL per concurrency level; no external side effects |

The Grafana project quota remains the hard monthly control and should stay at 200 VUh. The script does not modify Grafana billing or quota configuration.

## Coverage

| Area | Request or assertion | Data effect |
|---|---|---|
| Secret contract | `onestage-k6-users` is valid JSON with exactly 22 unique username/password records | None |
| Authentication | Cognito `USER_PASSWORD_AUTH` returns an access token for every synthetic user | Cognito authentication only |
| Health | `GET /api/{event,auth,inventory,queue,order,ticket}/health` | None |
| Catalog | Event list, venue list, and event detail | None |
| Booking catalog | Authenticated ticket zones plus seat inventory for a published seated event, when one exists | None |
| Customer account | Current customer's tickets | None |
| Existing detail | First ticket detail, when that customer already has one | None |
| Security | Anonymous customer order and ticket reads return `401` | None |
| Queue guards | Invalid authenticated queue-position lookup returns `400`; anonymous queue join is rejected by auth (`401`) or Kong throttling (`429`) | None |
| Booking guards | Anonymous hold, order, and payment attempts are rejected by auth (`401`) or Kong throttling (`429`); invalid authenticated order detail returns `400` | None |
| No-oversell evidence | 50 concurrent authenticated hold attempts race for 10 tickets; exactly 10 must succeed and 40 must be safely rejected | Disposable CI MySQL only; fixture is deleted after verification |
| Queue capacity | 100 synthetic buyers join the real queue handler; SQL requires 100 unique customer entries and distinct positions 1–100 | Disposable CI MySQL only |
| Checkout capacity | 50 sequential buyers plus 30 attempts across three concurrent buyers must all create and pay orders; SQL reconciles 80 paid orders, payments, and sold inventory | Disposable CI MySQL only |
| Payment drain | The real payment consumer drains 40 valid in-memory SQS messages and reports elapsed time and throughput | Memory only |
| Mixed queue/checkout | Overlap joins, admission and GA checkout on one event; require 300 successful joins, 200 paid orders, 500 distinct positions and reconciled payments/stock | Disposable CI MySQL only |
| Concurrent end-to-end | 20 buyers traverse queue admission, reserved-seat checkout, and simulated payment at 5, 10 and 20 VUs; SQL reconciles queue release and sold seats | Disposable CI MySQL only |
| Traceability | Every Kong response includes `X-Request-Id` | None |

Notification is intentionally absent because Kong does not expose it publicly. Authenticated queue status/position and order list/detail are excluded because those nominal `GET` handlers can open queue sessions, expire admissions or reservations, and release queue capacity. Successful queue joins, inventory holds, order/payment creation, ticket issuance/check-in, event management, and notifications remain excluded from the cloud suite. Its non-GET requests are deliberately unauthenticated contract checks: `401` proves application auth rejection, while `429` proves Kong rejected the request before the application mutation path. These probes run in a separate, fixed-rate scenario so they do not dominate the read-load profile.

## Thresholds

- HTTP failures below 1%; abort after the first 30 seconds if failures reach 10%.
- Overall p95 below 2 seconds; health below 1 second; public reads below 1.5 seconds; authenticated reads below 2 seconds.
- Cognito p95 below 2 seconds.
- Functional, authentication, and request-ID checks must pass 100%; overall security checks must exceed 99.9%, and anonymous-write rejection must exceed 99.8%.
- Unexpected backend `5xx` responses must remain below 0.1%. Kong `429` responses are counted separately as rate-limit protection, not application failures.
- Dropped iterations must remain zero.

## Required configuration

GitHub Actions:

- Secret: `K6_CLOUD_TOKEN`
- Variables: `K6_BASE_URL`, `K6_CLOUD_PROJECT_ID`, `K6_CLOUD_STACK_ID`, `K6_LOAD_ZONE`

Grafana Cloud k6 Secrets Management:

- Secret name: `onestage-k6-users`
- Value shape (use the 22 retained synthetic customers; never commit the actual values):

```json
[
  { "username": "synthetic-user-01", "password": "replace-in-grafana" },
  { "username": "synthetic-user-02", "password": "replace-in-grafana" }
]
```

The configured Cognito app client must continue to allow `USER_PASSWORD_AUTH`. The suite uses access tokens, matching the frontend.

## GitHub deployment gate

1. Open **Actions → Deploy backend → Run workflow**.
2. Select the ref to deploy.
3. Enable `run_load_test`.
4. Run the workflow.

The load test starts only after all ECS deployment matrix jobs report stable. Threshold failure emits a workflow warning and retains the deployment; it does not fail or roll back deployment. Normal pushes to `main` cannot opt into the load test.

## Disposable no-oversell evidence

The `k6 academic concurrency evidence` workflow starts MySQL inside the GitHub runner, loads only the inventory tables needed by the real inventory service, and injects a test-only Cognito verifier into that process. It does not call Cognito or any other AWS service.

The k6 scenario sends 50 one-ticket hold attempts from 20 VUs against a 10-ticket fixture. It requires exactly 10 `201` responses, 40 safe `409` responses, no unexpected response, and no `5xx`. A separate SQL verifier then proves `reserved_qty + sold_qty <= total_qty` and reconciles successful responses with active hold rows. The fixture process deletes its event, inventory, and hold rows on shutdown; the entire MySQL service is discarded with the job. The JSON k6 summary is retained as a GitHub artifact for 14 days.

## Isolated buyer capacity evidence

The same workflow has B1, B2, B3, mixed-load, and concurrent A jobs. Each MySQL-backed job receives a new GitHub service container, applies the production schema (including migration 20), injects deterministic `test-token:<sub>` identities only after `NODE_ENV=test`, and starts the real Express handlers in-process. No AWS credentials are configured. Payment uses the existing `simulated` token; ticket issuance, notifications, SQS URLs, and queue-refill callbacks remain disabled. Concurrent calls to the real admission endpoint are explicit in mixed/journey tests; this is not an AWS scheduler test.

B1 exercises queue-join concurrency. B2 requires all 50 sequential purchases and all 30 attempts across three concurrent buyers to succeed against 100 tickets. Both phases gate CI: 409 and 5xx responses are failures, and SQL verification requires exactly 80 paid orders and payments, 80 sold tickets, and no outstanding reservation. The contention counters remain in the artifact for diagnosis.

Earlier B2 probes classified checkout deadlocks as expected failures, allowing 66/80 buyers to succeed while the job passed. Both services now share bounded transaction retries for deadlocks and lock timeouts, with rollback and connection release before retry. Order creation/release updates queue entries by primary key, with no session subquery inside the update. Queue admission/expiry discovers candidates without secondary-index locks and rechecks them through primary-key updates. Connections are released before external callbacks or event publication.

Queue validation requires all 100 stored positions to be distinct and span 1–100. Joins increment `queue_sessions.next_position` while holding the session mutex, rather than locking a session-wide `MAX(position)` scan. Admission advances `serving_position`; `GET queue/me` retains its one-based `position` response, now an upper-bound estimate calculated without a per-poll count. Abandoned waiting tickets may inflate that estimate.

The mixed test gates CI on **zero** HTTP/check failures: 200 admitted buyers check out against 300 tickets while 300 new buyers join the same session and admission calls run concurrently. Its SQL verifier requires 200 paid orders, captured payments, confirmed holds, released buyer slots and sold tickets, no reserved stock, and 500 distinct stored positions. The A matrix separately requires 20/20 seated journeys at each of 5, 10 and 20 VUs. These are local correctness/contention checks, not claims about deployed website capacity.

### Re-run mixed load locally

Use only an explicitly selected disposable MySQL instance. Existing local schemas need migration 20 and the counter backfill first; see [database rollout instructions](../infrastructure/sql/QUICK-START.md#queue-counter-rollout-migration-20). Do not rerun the full initialization script against a populated database.

In terminal 1, from the repository root (using your disposable database password):

```powershell
$env:DB_HOST = '127.0.0.1'
$env:DB_PORT = '3307'
$env:DB_USER = 'root'
$env:DB_PASSWORD = 'your-disposable-db-password'
$env:DB_SSL = 'false'
$env:K6_FIXTURE_ENV_FILE = Join-Path $PWD '.k6-mixed.env'
New-Item -ItemType Directory -Force .\k6-results | Out-Null
node --import tsx scripts/start-k6-buyer-fixture.mjs mixed 2>&1 |
  Tee-Object .\k6-results\mixed-fixed-server.log
```

Leave that fixture running. In terminal 2, set the same database environment, then:

```powershell
Get-Content .k6-mixed.env | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$') {
    Set-Item -Path "Env:$($matches[1])" -Value $matches[2]
  }
}
& 'C:\Program Files\k6\k6.exe' run --summary-export .\k6-results\mixed-fixed.json .\k6\mixed-buyer-capacity.js
node scripts/verify-k6-buyer-fixture.mjs mixed
```

Expect 300 joins, 200 paid orders, zero failures, and passing SQL invariants. Stop the fixture with Ctrl+C. Use a **new fixture event for every run**, including B1/B2 and each journey concurrency level. Fixture events remain in the disposable database until that database is discarded; do not clean unrelated events. Never load-test a deployed target with these test-only identities.

### Local regression evidence — 18 October 2026 (SGT)

The working-tree fix based on `c419640` was tested against a separate disposable MySQL 8.4 instance, not the existing local website database or AWS. These are local results, not a GitHub Actions or deployed-capacity claim.

| Profile | Observed result | HTTP failures |
|---|---|---|
| B1, 20 VUs | 100/100 joins; 100 distinct positions, 1–100 | 0 |
| B2, original baseline/probe | 80/80 paid orders; payments, holds and sold stock reconciled | 0 |
| Mixed, three fresh events | Each run: 300/300 joins at 100 VUs, 200/200 paid orders at 20 VUs, 100/100 admission calls; 500 distinct positions | 0 |
| Journey, 5 VUs | 20/20 paid seated journeys; released queue entries and sold seats reconciled | 0 |
| Journey, 10 VUs | 20/20 paid seated journeys; released queue entries and sold seats reconciled | 0 |
| Journey, 20 VUs | 20/20 paid seated journeys; released queue entries and sold seats reconciled | 0 |

After all load runs, MySQL `lock_deadlocks` and `lock_timeouts` were both zero. Migration 20 was reapplied twice successfully. A legacy-session backfill test confirmed the allocation maximum, admission-based serving maximum (not merely a buyer who left while waiting), monotonic counters and safe reruns. The full backend suite passed on another fresh disposable database: 335 Node tests and 74 notification tests, with no failures or skips. Build and lint passed; existing lint warnings remain. Local summaries and logs are in the ignored `k6-results/` directory; the updated workflow will upload its own JSON and server-log evidence when run in CI.

The subsequent expiry-backlog review found that status-only capacity counting still included expired tokens outside the 200-row cleanup batch. Capacity counting now requires `token_expires_at > CURRENT_TIMESTAMP` for both `ADMITTED` and `IN_CHECKOUT` buyers. Four real-MySQL regression cases are registered in the normal backend test suite: each 1,000-expired/1,000-waiting case now admits all 1,000 buyers in one call while cleanup remains capped at 200; mixed live buyers still occupy slots, and full live capacity still admits nobody. Three of these cases failed before the query correction. Afterward all 339 Node tests and 74 notification tests passed, as did build and lint. A fresh mixed-load rerun again completed 300 joins, 200 paid orders and all SQL invariants with zero HTTP failures and zero additional MySQL deadlocks/timeouts. Follow-up evidence uses the `expiry-capacity-*`, `expiry-fix-unit.log` and `expiry-fixed-mixed*` files in `k6-results/`.

The B3 test uses the production `consumePayments` loop with a bounded in-memory SQS implementation. It is a deterministic worker-capacity measurement, not an AWS SQS performance claim. Its JSON artifact reports message count, synthetic processing delay, wall-clock drain time, throughput, and the current single-worker concurrency.

## Manual website test

1. Open Grafana Cloud stack `onestage` and go to **Testing & synthetics → Performance**.
2. Select project ID `8484325`, then **New test → Script editor → Start scripting**.
3. Select the k6 **v2.x** runtime.
4. Paste the complete contents of `k6/read-only.js`. It is standalone and defaults to the manual profile.
5. Save it as `OneStage read-only manual`. Select **Create** to retain it without running, or **Create and run** when a test is intended.

The website profile is deliberately a static export so Grafana can show its VUh estimate before starting. The separate `k6/deployment-gate.js` entry point selects the shorter GitHub profile. Confirm the Singapore load zone and estimated VUh in the run preview before starting.

## Static validation

Static inspection is safe and does not authenticate or send traffic:

```bash
k6 inspect k6/deployment-gate.js
k6 inspect k6/read-only.js
k6 inspect -e K6_EVENT_ID=1 -e K6_INVENTORY_ITEM_ID=1 k6/disposable-concurrency.js
```

Do not use `k6 run` for this suite without an explicit secret source and explicit authorization to send load to the selected target.
