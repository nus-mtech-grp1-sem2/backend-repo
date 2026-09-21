# Mock payment processing

The checkout calls `POST /orders/:orderId/payment-requests` with only
`{ "paymentToken": "simulated" }`. Authentication and order ownership are checked
before publishing. Card number, CVC, and expiry must never be sent here or to SQS.

## Flow and compatibility

1. With `PAYMENT_REQUESTS_QUEUE_URL` configured, the endpoint publishes a
   `PaymentRequested` v1 command with `orderId` and `customerSub`, delayed seven
   seconds, then responds **202** with `{ order, paymentStatus: "PROCESSING" }`.
2. A long-poll worker inside the existing order-service container processes it.
   Order-row locks and the existing PAID check make duplicate captures safe.
3. Successful processing publishes `OrderPaid` to the existing **order-events**
   queue with a separate ten-second issuance delay. Only ticket-service consumes that queue. Do not share these queues:
   ticket-service discards unknown message types.
4. Checkout polls `GET /orders/:orderId` every two seconds. Only PAID means
   success; FAILED/CANCELLED stop checkout. After 30 polls it offers manual
   status checks. A session-storage order-ID marker resumes checks after refresh;
   it contains no card details. A different browser can safely resubmit the
   pending order: duplicate commands do not capture twice.

This is an additive API; the legacy `POST /orders/:orderId/payment` remains
synchronous for older clients. Deploy the new backend before the new frontend.
Without a configured payment queue, the new endpoint waits seven seconds and
processes synchronously for local development (200 on success). A configured but
unreachable queue returns 503; it never silently falls back to synchronous
capture. A lost acknowledgement is ambiguous: clients check order status rather
than automatically resubmitting.

No schema migration or extra ECS service is required. Orders remain PENDING
while queued. The existing reservation expiration policy still applies; a
delayed request for an expired hold releases any still-active reservation and
marks the order FAILED without capturing. A worker replay must not release a
newer checkout for the same customer; queue releases match the hold's expiry.

## Operations and rollout

Terraform targets the existing OneStage stack (account 195663985359,
ap-southeast-1, existing remote state/workspace). Review the plan for unrelated
drift before applying. This change does not authorize an apply or deployment.

- Creates encrypted `onestage-payment-requests` and a separate encrypted DLQ.
  Visibility: 60 seconds; maximum receives: 5. Main retention: four days;
  DLQ retention: fourteen days. Only the order task can send/receive/delete.
- A CloudWatch alarm tracks visible DLQ messages. It has **no notification
  action** configured; an operator must monitor it or separately wire alerts.
- Worker logs contain order/message identifiers and outcomes, not card fields.
  Invalid messages and transient processing/publishing failures remain for retry
  and eventually enter the DLQ. The order row stays PENDING if processing never
  succeeded; PAID if capture succeeded but ticket publication failed.
- Investigate the order-service logs, order/hold status, and DLQ before redriving.
  Redrive only after the cause is fixed. Replaying PAID orders republishes
  OrderPaid without capturing twice; expired orders cannot be paid.
- For an ambiguous enqueue failure that remains PENDING, an operator can verify
  the queue/DLQ and safely resubmit the same order, provided the hold is active.
- Additional costs are SQS API requests and the CloudWatch alarm; no additional
  always-on container. Long polling limits empty receives. Exact cost depends
  on traffic and account allowances.
- Roll back frontend first. Keep the queue and compatible worker running until
  commands drain; do not delete a queue with outstanding work or disable its
  worker as a shortcut. Then remove wiring only through a reviewed plan.

Tests use mocked SQS, MySQL, and Cognito. They do not prove a live AWS deployment.

## Local verification (2026-09-21)

- Frontend `npm test -- --watch=false`: 153 passing tests.
- Frontend `npm run build`: passed; existing home CSS budget warning remains.
- Prettier check on all four checkout files: passed. `git diff --check`: passed.
- Backend `npm test -w services/order -w services/ticket`: 34 order and 28
  ticket tests passed.
- Changed order-service implementation passed strict TypeScript checking with
  the repository compiler. Root `npx tsc --noEmit` still fails in unrelated
  inventory/notification/test-support files (implicit type, missing dependency
  types, and pre-existing module-mode errors).
- `terraform fmt -check -recursive` and `terraform validate`: passed after
  backend-disabled initialization in a temporary provider directory. Added the
  official Windows checksums to the existing provider lock file; provider
  versions did not change. No plan/apply or remote-state access was performed.
- TFLint and tfsec were unavailable locally. No browser/AXE or live AWS test ran.
- `npm audit --audit-level=high`: backend passes the high-severity threshold
  with two existing moderate findings; frontend fails with one high and two
  moderate findings in unchanged dependencies. No dependency upgrades performed.

The API/Angular skills led to preserving the legacy endpoint, adding polling
instead of treating HTTP acceptance as success, and testing duplicate delivery.
The Terraform skill kept infrastructure changes local and separately validated.

## Ticket issuance delay

Ticket issuance now waits at least ten seconds from the persisted payment time,
separate from the seven-second payment buffer. Both the SQS worker and internal
issuance path check the database clock before opening an issuance transaction.
Reconciliation excludes payments younger than ten seconds, so it cannot bypass
the delay. Older paid orders and message retries do not restart the clock.

In local fallback mode the internal endpoint responds 202 while scheduling
issuance, allowing payment to finish and the customer to see "issuing ticket".
The existing reconciliation sweep recovers unissued tickets for paid orders after restart.
The UI's five-second ticket polling means visible tickets may appear a few
seconds after issuance; queue backlog/recovery can add further time. Already
issued tickets are never hidden or delayed on reload.

The internal issuance endpoint can now return 202 instead of 200 for recent
payments. Its order-service caller already accepts either success status.
Deploy the updated ticket service as well as order-service for consistent
behavior across SQS, local fallback, and reconciliation; Terraform alone does
not prevent the old reconciliation code from issuing early. No frontend change
is needed. These changes do not authorize deployment or Terraform apply.
