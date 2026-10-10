# OneStage k6 test evidence

This suite exercises the deployed public and customer read paths without creating, updating, or deleting application data. It authenticates 22 retained synthetic customers directly against Cognito and executes from the Grafana Cloud Singapore load zone.

## Profiles and cost guardrails

| Profile | Trigger | Shape | Maximum |
|---|---|---|---|
| Deployment | `Deploy backend` workflow dispatch with `run_load_test=true` | 1 → 10 VUs, then 10 → 50 VUs, steady at 50, ramp down; one security probe/second | 50 read VUs, 5 minutes, about 2.75 VUh |
| Manual | Grafana Cloud k6 website | 1 → 10 VUs, then 10 → 50 VUs, steady at 50, ramp down; one security probe/second | 50 read VUs, 8.5 minutes, about 4.13 VUh |
| Disposable concurrency | Pull request or manual GitHub Action | 20 VUs race 50 one-ticket holds against 10 tickets | Local CI only, under 30 seconds, no AWS usage |

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
| Traceability | Every Kong response includes `X-Request-Id` | None |

Notification is intentionally absent because Kong does not expose it publicly. Authenticated queue status/position and order list/detail are excluded because those nominal `GET` handlers can open queue sessions, expire admissions or reservations, and release queue capacity. Successful queue joins, inventory holds, order/payment creation, ticket issuance/check-in, event management, and notifications remain excluded from the cloud suite. Its non-GET requests are deliberately unauthenticated contract checks: `401` proves application auth rejection, while `429` proves Kong rejected the request before the application mutation path. These probes run in a separate, fixed-rate scenario so they do not dominate the read-load profile.

## Thresholds

- HTTP failures below 1%; abort after the first 30 seconds if failures reach 10%.
- Overall p95 below 2 seconds; health below 1 second; public reads below 1.5 seconds; authenticated reads below 2 seconds.
- Cognito p95 below 2 seconds.
- Functional, authentication, security, anonymous-write rejection, and request-ID checks must pass 100%.
- Unexpected backend `5xx` responses must remain zero. Kong `429` responses are counted separately as rate-limit protection, not application failures.
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

## Manual website test

1. Open Grafana Cloud stack `onestage` and go to **Testing & synthetics → Performance**.
2. Select project ID `8484325`, then **New test → Script editor → Start scripting**.
3. Select the k6 **v2.x** runtime.
4. Paste the complete contents of `k6/read-only.js`. It is standalone and defaults to the manual profile.
5. Save it as `OneStage read-only manual`. Select **Create** to retain it without running, or **Create and run** when a test is intended.

Do not set `K6_PROFILE=deployment` on the website test; that value is reserved for the GitHub gate. Confirm the Singapore load zone and estimated VUh in the run preview before starting.

## Static validation

Static inspection is safe and does not authenticate or send traffic:

```bash
k6 inspect k6/deployment-gate.js
k6 inspect k6/read-only.js
k6 inspect -e K6_EVENT_ID=1 -e K6_INVENTORY_ITEM_ID=1 k6/disposable-concurrency.js
```

Do not use `k6 run` for this suite without an explicit secret source and explicit authorization to send load to the selected target.
