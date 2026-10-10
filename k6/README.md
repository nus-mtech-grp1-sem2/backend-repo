# OneStage read-only load tests

This suite exercises the deployed public and customer read paths without creating, updating, or deleting application data. It authenticates 22 retained synthetic customers directly against Cognito and executes from the Grafana Cloud Singapore load zone.

## Profiles and cost guardrails

| Profile | Trigger | Shape | Maximum |
|---|---|---|---|
| Deployment | `Deploy backend` workflow dispatch with `run_load_test=true` | 0 → 10 VUs, then 10 → 50 VUs, steady at 50, ramp down | 50 VUs, 5 minutes, about 2.58 VUh |
| Manual | Grafana Cloud k6 website | 0 → 10 VUs, then 10 → 50 VUs, steady at 50, ramp down | 50 VUs, 15 minutes, about 8.92 VUh |

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
| Queue guards | Invalid authenticated queue-position lookup returns `400`; anonymous queue join returns `401` before database access | None |
| Booking guards | Anonymous hold, order, and payment attempts return `401`; invalid authenticated order detail returns `400` | None |
| Traceability | Every Kong response includes `X-Request-Id` | None |

Notification is intentionally absent because Kong does not expose it publicly. Authenticated queue status/position and order list/detail are excluded because those nominal `GET` handlers can open queue sessions, expire admissions or reservations, and release queue capacity. Successful queue joins, inventory holds, order/payment creation, ticket issuance/check-in, event management, and notifications remain excluded. Non-GET requests in this suite are deliberately unauthenticated contract checks whose handlers return `401` before their mutation paths.

## Thresholds

- HTTP failures below 1%; abort after the first 30 seconds if failures reach 10%.
- Overall p95 below 2 seconds; health below 1 second; public reads below 1.5 seconds; authenticated reads below 2 seconds.
- Cognito p95 below 2 seconds.
- Functional, authentication, security, and request-ID checks must pass 100%.
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

The load test starts only after all ECS deployment matrix jobs report stable. Threshold failure marks the workflow red and retains the deployment; there is no automatic rollback. Normal pushes to `main` cannot opt into the load test.

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
```

Do not use `k6 run` for this suite without an explicit secret source and explicit authorization to send load to the selected target.
