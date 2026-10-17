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
| A small end-to-end | Pull request or manual GitHub Action | 10 sequential queue → admission → seat → order → simulated-payment journeys | Disposable full-schema MySQL; no external side effects |

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
| Queue capacity | 100 synthetic buyers join the real queue handler; SQL verifies 100 unique customer entries | Disposable CI MySQL only |
| Checkout capacity | 50 sequential buyers plus 30 attempts across three concurrent buyers must all create and pay orders; SQL reconciles 80 paid orders, payments, and sold inventory | Disposable CI MySQL only |
| Payment drain | The real payment consumer drains 40 valid in-memory SQS messages and reports elapsed time and throughput | Memory only |
| Small end-to-end | 10 buyers traverse queue admission, reserved-seat checkout, and simulated payment; SQL reconciles queue release and sold seats | Disposable CI MySQL only |
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

The same workflow has independent B1, B2, B3, and A jobs. Each MySQL-backed job receives a new GitHub service container, applies the production schema, injects deterministic `test-token:<sub>` identities only after `NODE_ENV=test`, and starts the real Express handlers in-process. No AWS credentials are configured. Payment uses the existing `simulated` token; ticket issuance, notifications, SQS URLs, and queue-refill callbacks remain disabled.

B1 exercises queue-join concurrency. B2 requires all 50 sequential purchases and all 30 attempts across three concurrent buyers to succeed against 100 tickets. Both phases gate CI: 409 and 5xx responses are failures, and SQL verification requires exactly 80 paid orders and payments, 80 sold tickets, and no outstanding reservation. The contention counters remain in the artifact for diagnosis.

Earlier B2 probes classified checkout deadlocks as expected failures, allowing 66/80 buyers to succeed while the job passed. The order service now discovers expiry candidates without locking event-wide order indexes, rechecks candidates under primary-key locks, and locks individual queue entries without taking an exclusive lock on their shared session. Database transactions retry deadlocks and lock timeouts after rollback; connections are released before response loading, queue refill, and ticket callbacks. A remains a sequential integration journey rather than a capacity claim.

Queue validation asserts 100 unique customers rather than unique stored `position` values. Local concurrency validation accepted all 100 buyers but produced only 13 distinct stored positions because concurrent joins calculate `MAX(position) + 1` without a uniqueness constraint. The workflow records position cardinality in its log so the ordering defect is visible without making unrelated API changes.

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
