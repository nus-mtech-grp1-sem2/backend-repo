# OneStage Ticketing

A ticketing platform where Organisers run Events (general-admission or seated), Customers reserve and buy tickets, and Helpers assist with day-of check-in. Inventory is split across four schemas — `event_inventory`, `queue`, `checkout`, `ticketing` — owned by separate services that talk over HTTP, not shared database access.

## Language

**Hold**:
A time-boxed, per-customer reservation of inventory (a GA quantity or specific seats) created before payment. Lifecycle: `ACTIVE` → `CONFIRMED` (payment succeeded) or `RELEASED`/`EXPIRED` (abandoned). Ownership is proven by the caller's authenticated identity (Cognito `sub`), not a separate secret token — unlike Queue's `admission_token`, a Hold doesn't need its own bearer credential because every request that touches it is already authenticated.
_Avoid_: Reservation, Lock, Block.

**Order**:
The record of a Customer's intent to purchase, created against exactly one Hold. Starts `PENDING`, becomes `PAID` once Payment succeeds (which also confirms the Hold and debits inventory for real), or `FAILED`/`CANCELLED`.
_Avoid_: Purchase, Transaction, Booking.

**Payment**:
Simulated for this project — there is no real processor integration. The Customer picks a method (Apple Pay / Samsung Pay / Card) and enters details that are accepted without validation; submitting always results in a captured Payment and a `PAID` Order. "Simulated" describes the processor, not the bookkeeping: Payment still really confirms the Hold and debits inventory.
_Avoid_: Charge (implies real money movement).

## Oversell prevention (Holds) — implemented this cycle

OR-03's acceptance criterion — "saved inventory count is the single source of truth the locking
engine checks against on every reservation" — had no implementation until now: `holds.test.ts`
already asserted `POST /events/{eventId}/holds` should return 201, but the route didn't exist
(404), and `HOLD_TTL_SECONDS`/`MAX_HOLD_QTY` were dead constants. The schema had already been
provisioned for this (`inventory_holds` table, `inventory_items.reserved_qty`/`sold_qty` +
`chk_inventory_counts CHECK (reserved_qty + sold_qty <= total_qty)`, `seats.hold_id`) — nothing
was writing to any of it.

**What's now implemented, in `services/inventory/src/index.ts`:**
- `POST /events/:eventId/holds` — any authenticated customer can hold inventory for a
  `PUBLISHED` event. `TIER1_GA` body: `{ inventoryItemId, quantity }`. `TIER2_SEATED` body:
  `{ inventoryItemId, seatIds }` (holds the exact named seats, not just a count, so two customers
  can't both be handed the same seat). Returns `201` with `{ holdId, eventId, inventoryItemId,
  quantity, status: 'ACTIVE', expiresAt, seatIds? }`.
- **The actual "never oversell" mechanism**: inside one transaction, `SELECT ... FOR UPDATE` locks
  the `inventory_items` row (and, for seated holds, every named `seats` row too) before comparing
  `quantity` against `total_qty - reserved_qty - sold_qty`. This serializes concurrent requests for
  the same inventory — the numeric check and the `reserved_qty` increment happen atomically, so two
  requests can never both read "enough available" and both succeed past capacity. The DB's
  `chk_inventory_counts` CHECK constraint is a second, DB-level backstop if application logic is
  ever wrong.
- **Deadlock retry**: under real concurrency, InnoDB legitimately deadlocks two transactions
  racing for the same row (`ER_LOCK_DEADLOCK`/`ER_LOCK_WAIT_TIMEOUT`) — that's expected, not a bug,
  and MySQL's own guidance is to retry. `createHold` retries the whole attempt (fresh transaction)
  up to `MAX_HOLD_LOCK_RETRIES` (5) times before giving up with `409 hold_contention_exceeded`; it
  never partially commits, so a retry can never cause an oversell either.
- **Lazy TTL expiry**: `expireStaleHolds` runs at the start of every hold attempt, inside the same
  lock, and releases any `ACTIVE` hold past its `expires_at` (decrements `reserved_qty`, frees any
  held seats back to `AVAILABLE`, marks the hold `EXPIRED`) before evaluating the new request. This
  avoids needing a cron job/worker (no new infra, per repo policy) while still guaranteeing
  abandoned holds don't permanently shrink availability.

**Deliberately not built this cycle** (would need a driving test + a real caller):
- `POST /holds/{holdId}/confirm` and `POST /holds/{holdId}/release` — named in
  `database/onestage-system-design.md`'s endpoint table as the next steps in the Hold lifecycle
  (`ACTIVE` → `CONFIRMED`/`RELEASED`). `confirm` is meant to be called synchronously by the
  Checkout/Order service before it marks an order `PAID` — but `order` (and `queue`) are still
  `/health`-only stubs (see earlier audit in this file's history / `event-inventory/CONTEXT.md`),
  so there's no real caller to build this against yet, and no test to drive it. Until `confirm`
  exists, a hold that's actually paid for just stays `ACTIVE`/reserved rather than moving to
  `sold_qty` — this does not create an oversell risk (reserved_qty still correctly excludes that
  inventory from being double-booked), it just means "sold" isn't yet distinguished from "held" in
  the data. A voluntary early `release` (customer changes their mind) is likewise not built; today
  inventory only frees up via the TTL, which is correct but not as prompt as it could be.
- **Naming note**: `database/onestage-system-design.md`'s endpoint table lists this route as
  `POST /events/{eventId}/inventory/hold` (singular); the actual implementation matches
  `holds.test.ts`, which was already committed expecting `POST /events/{eventId}/holds` (plural,
  no `/inventory` segment). Went with what the test already specified as the agreed contract;
  the design doc's path is now stale and should be corrected to match, or the route renamed —
  flagging rather than silently picking one, since it's a cross-doc inconsistency, not a decision
  made in this session.

**Test coverage**: `services/inventory/src/holds.test.ts`, 5 tests, all green — happy-path GA hold,
rejecting a request that exceeds remaining quantity, five concurrent requests racing for capacity
that only fits three of them (asserts `reserved_qty` never exceeds `total_qty` and the successful
count matches what actually fits), holding specific seats for a seated event, and rejecting a
seat-hold request when one of the named seats is already held by someone else (asserts the whole
request fails atomically — the other, still-free seat in that request is not partially claimed).
Also fixed a latent bug in `test-helpers.ts`'s `destroyFixture`: it deleted `inventory_holds`
before `seats`, which FK-fails once a seat can actually carry a `hold_id` (nothing exercised that
path before this cycle).
