# OneStage — System Design

*SWE5001 — Architecting Scalable Systems, Graduate Certificate in Architecting Scalable Systems (NUS–ISS)*

Data models, domain class diagrams, and API surface for the five backend services, derived from the [user stories](https://claude.ai/code/artifact/7a3e1db9-56dc-4d3f-8bc1-3c5d870a97a2). One Amazon RDS for MySQL instance plays five independent databases via schema-per-service; Cognito owns authentication; a single SQS queue carries the one hand-off that can safely be asynchronous.

**At a glance:** 5 backend services · 1 MySQL instance, 5 schemas · 13 tables · 36 API endpoints · 1 SQS queue.

---

## Architecture overview

Three static single-page apps (Buyer, Organizer Portal, Scanner) are served from S3 via CloudFront and call the backend over HTTPS with a Cognito JWT. Path-based routing on a single ALB/API Gateway sends each request to the right ECS service. Every service owns one schema in one shared MySQL instance — there is no cross-schema foreign key anywhere in this design, only plain columns that reference another schema's row by id, exactly as if each service had its own database.

```mermaid
graph TB
    subgraph Frontend["Static Frontend — S3 + CloudFront"]
        Buyer["Buyer App"]
        Portal["Organizer Portal"]
        Scanner["Scanner App"]
    end

    Cognito[("Amazon Cognito<br/>User Pool")]

    GW["ALB / API Gateway<br/>path-based routing"]

    subgraph ECS["Amazon ECS Cluster"]
        EIS["Event & Inventory<br/>Service"]
        WR["Waiting Room /<br/>Queue Service"]
        CPS["Checkout & Payment<br/>Service"]
        TIV["Ticket Issuance &<br/>Validation Service"]
        NS["Notification<br/>Service"]
    end

    subgraph DB["Single Amazon RDS for MySQL Instance"]
        SchemaEI[(event_inventory schema)]
        SchemaQ[(queue schema)]
        SchemaCO[(checkout schema)]
        SchemaTI[(ticketing schema)]
        SchemaN[(notification schema)]
    end

    SQS{{"Amazon SQS<br/>order-events queue"}}
    Gmail[("Gmail SMTP")]

    Buyer -->|HTTPS + JWT| GW
    Portal -->|HTTPS + JWT| GW
    Scanner -->|HTTPS + JWT| GW
    Buyer -.sign in.-> Cognito
    Portal -.sign in.-> Cognito
    Scanner -.sign in.-> Cognito

    GW --> EIS
    GW --> WR
    GW --> CPS
    GW --> TIV

    EIS -->|owns| SchemaEI
    WR -->|owns| SchemaQ
    CPS -->|owns| SchemaCO
    TIV -->|owns| SchemaTI
    NS -->|owns| SchemaN

    CPS -->|publishes OrderPaid| SQS
    SQS -->|consumed by| TIV
    CPS -.confirm hold, sync.-> EIS
    WR -.check availability, sync.-> EIS
    TIV -.order confirmation, sync.-> NS
    NS -.sends via.-> Gmail
```

---

## Design decisions

**One database, five schemas, no cross-schema foreign keys.** A single Amazon RDS for MySQL instance hosts `event_inventory`, `queue`, `checkout`, `ticketing`, and `notification` — one per service — instead of five separate RDS instances, which keeps the school project's AWS bill and ops surface small. Each service's own tables carry real, enforced foreign keys. A reference to another service's row (e.g. `checkout.orders.event_id`) is stored as a plain unconstrained column instead, so the services stay logically independent and could be split onto separate instances later with zero schema change.

**Only one thing has to be synchronous: not overselling.** The one failure OneStage cannot tolerate is two buyers being confirmed for the same seat. So reserving and confirming an `InventoryHold` happens inside the Event & Inventory Service under a DB transaction, and Checkout calls `POST /holds/{id}/confirm` synchronously before it will mark an order `PAID` — if that call fails, the sale fails. Ticket generation and the confirmation email are not on that critical path, so Checkout instead publishes `OrderPaid` to the `order-events` SQS queue and Ticket Issuance consumes it asynchronously. That's the proposal's "event bus that decouples inventory and order events from downstream processing," scoped to the one hand-off where eventual consistency is actually fine.

**Authorization rides on one small table, not another service.** Cognito authenticates every request, but Organiser/Helper are per-event roles that don't map onto global Cognito groups. `event_team_memberships` in the Event & Inventory schema is the single source of truth: creating an event auto-inserts its creator as an accepted `ORGANISER`; an invitation creates a `PENDING` membership for the invitee's Cognito `sub`, with `granted_by_sub` set to the event owner's `organiser_sub`. Every organiser-or-helper-scoped endpoint in any service checks membership synchronously. Every other endpoint just requires a valid Cognito JWT — any signed-in user is a Customer by default.

**The confirmation email is its own service, one email per ticket, idempotent per ticket.** After Ticket Issuance creates the ticket rows for a paid order, it calls the Notification Service's `POST /notifications/order-confirmation` with the order's tickets, rather than sending mail itself. The Notification Service sends one email per ticket — each carrying only that ticket's QR code — and records one `email_notifications` row per ticket, so a booking of three tickets is three emails and three rows. Ticket Issuance does not wait on that call: sending mail takes seconds and must not slow the payment path, and the Notification Service records each ticket's `SENT`/`FAILED` outcome itself. It's idempotent on `ticket_id` — a unique key on `email_notifications` — so a retried call can never double-email a customer: tickets already `SENT` are skipped, and only tickets that are missing or `FAILED` are (re)sent. A delivery failure is recorded as `FAILED` and returned with a 201, not thrown back as an error: the order is already paid and the tickets already exist, so a bad SMTP credential degrades to "no confirmation email" instead of blocking or reversing the sale.

**What's deliberately left out.** Cognito's own login/token-refresh flow, network firewalls and WAF rules, a service mesh, and rate limiting beyond the waiting room's own admission control are all out of scope. IDs below are plain auto-increment `BIGINT`s rather than UUIDs, and every "email" field is a denormalized snapshot taken from the Cognito JWT at write time, so no service has to call another just to render a name.

---

## Event & Inventory Service — `event_inventory` schema

The platform's core technical risk: owns events, their inventory (GA quantity or a seat map), event-team roles, and the concurrency-safe hold that guarantees a seat or quantity is never sold twice.

### Data model

```mermaid
erDiagram
    EVENTS ||--o{ INVENTORY_ITEMS : offers
    EVENTS ||--o{ SEATS : contains
    EVENTS ||--o{ EVENT_TEAM_MEMBERSHIPS : "staffed by"
    EVENTS ||--o{ INVENTORY_HOLDS : locks
    INVENTORY_ITEMS ||--o{ SEATS : "maps to (Tier 2 only)"
    INVENTORY_ITEMS ||--o{ INVENTORY_HOLDS : "reserved via"
    SEATS ||--o| INVENTORY_HOLDS : "held by"

    EVENTS {
        bigint event_id PK
        varchar organiser_sub "Cognito sub, creator"
        varchar title
        text description
        varchar venue
        datetime starts_at
        int total_seats "event capacity"
        enum tier "TIER1_GA, TIER2_SEATED"
        enum status "DRAFT, PUBLISHED, CANCELLED"
        datetime created_at
        datetime updated_at
    }
    EVENT_TEAM_MEMBERSHIPS {
        bigint membership_id PK
        bigint event_id FK
        varchar user_sub "Cognito sub"
        varchar user_email
        enum role "ORGANISER, HELPER"
        enum invite_status "PENDING, ACCEPTED, REJECTED"
        varchar granted_by_sub
        datetime granted_at
        datetime responded_at "nullable"
    }
    INVENTORY_ITEMS {
        bigint inventory_item_id PK
        bigint event_id FK
        varchar name "e.g. General Admission"
        int total_qty
        int reserved_qty
        int sold_qty
        int price_cents
        int version "optimistic lock"
        datetime created_at
    }
    SEATS {
        bigint seat_id PK
        bigint event_id FK
        bigint inventory_item_id FK
        varchar seat_label "e.g. A12"
        enum status "AVAILABLE, HELD, SOLD"
        bigint hold_id FK "nullable"
        datetime updated_at
    }
    INVENTORY_HOLDS {
        bigint hold_id PK
        bigint event_id FK
        bigint inventory_item_id FK "nullable for seated"
        varchar customer_sub "Cognito sub"
        int quantity
        enum status "ACTIVE, CONFIRMED, RELEASED, EXPIRED"
        bigint order_id "logical ref -> checkout.orders, no FK"
        datetime expires_at
        datetime created_at
    }
```

### Domain model

```mermaid
classDiagram
    class Event {
        +Long eventId
        +String organiserSub
        +String title
        +String description
        +String venue
        +DateTime startsAt
        +int totalSeats
        +Tier tier
        +EventStatus status
        +publish()
        +cancel()
        +updateDetails()
    }
    class EventTeamMembership {
        +Long membershipId
        +Long eventId
        +String userSub
        +String userEmail
        +Role role
        +InvitationStatus inviteStatus
        +String grantedBySub
        +DateTime grantedAt
        +DateTime respondedAt
    }
    class InventoryItem {
        +Long inventoryItemId
        +Long eventId
        +String name
        +int totalQty
        +int reservedQty
        +int soldQty
        +int priceCents
        +int version
        +reserve(int qty)
        +release(int qty)
        +confirm(int qty)
        +availableQty() int
    }
    class Seat {
        +Long seatId
        +Long eventId
        +Long inventoryItemId
        +String seatLabel
        +SeatStatus status
        +hold(Long holdId)
        +release()
        +sell()
    }
    class InventoryHold {
        +Long holdId
        +Long eventId
        +Long inventoryItemId
        +String customerSub
        +int quantity
        +HoldStatus status
        +Long orderId
        +DateTime expiresAt
        +confirm(Long orderId)
        +release()
        +isExpired() bool
    }
    class Tier {
        <<enumeration>>
        TIER1_GA
        TIER2_SEATED
    }
    class EventStatus {
        <<enumeration>>
        DRAFT
        PUBLISHED
        CANCELLED
    }
    class SeatStatus {
        <<enumeration>>
        AVAILABLE
        HELD
        SOLD
    }
    class HoldStatus {
        <<enumeration>>
        ACTIVE
        CONFIRMED
        RELEASED
        EXPIRED
    }
    class Role {
        <<enumeration>>
        ORGANISER
        HELPER
    }
    class InvitationStatus {
        <<enumeration>>
        PENDING
        ACCEPTED
        REJECTED
    }
    class EventInventoryService {
        <<service>>
        +createEvent(dto) Event
        +configureInventory(eventId, dto)
        +publishEvent(eventId)
        +addTeamMember(eventId, email, role)
        +removeTeamMember(eventId, userSub)
        +reserveInventory(eventId, itemId, qty, seatIds) InventoryHold
        +confirmHold(holdId, orderId)
        +releaseHold(holdId)
        +isAuthorised(eventId, userSub, role) bool
    }

    Event "1" *-- "0..*" InventoryItem : offers
    Event "1" *-- "0..*" Seat : contains
    Event "1" *-- "0..*" EventTeamMembership : staffed by
    Event "1" *-- "0..*" InventoryHold : locks
    InventoryItem "1" o-- "0..*" Seat : maps to
    InventoryItem "1" <-- "0..*" InventoryHold : reserved via
    Seat "0..1" <-- "0..1" InventoryHold : held by
    EventInventoryService ..> Event : manages
    EventInventoryService ..> InventoryHold : manages
    EventInventoryService ..> EventTeamMembership : manages
```

### API endpoints

| Method | Path | Description | Caller |
|---|---|---|---|
| POST | `/events` | Create a draft event (creator becomes Organiser) | Customer |
| GET | `/events` | Browse / search published events | Any |
| GET | `/events/{eventId}` | Event detail incl. live availability | Any |
| PUT | `/events/{eventId}` | Edit event details | Organiser |
| POST | `/events/{eventId}/publish` | Publish the event | Organiser |
| POST | `/events/{eventId}/cancel` | Cancel the event | Organiser |
| PUT | `/events/{eventId}/inventory` | Configure ticket quantity / seat map | Organiser |
| GET | `/events/{eventId}/seats` | Seat map with live status | Any |
| POST | `/events/{eventId}/invitations` | Create a pending invitation by email as Organiser or Helper | Organiser |
| POST | `/team-invitations/{membershipId}/accept` | Accept the caller's pending invitation | Invited user |
| POST | `/team-invitations/{membershipId}/reject` | Reject the caller's pending invitation | Invited user |
| GET | `/team-invitations` | List the caller's pending invitations | Signed-in user |
| GET | `/events/{eventId}/team-members` | View the event's team roster | Organiser / Helper |
| PATCH | `/events/{eventId}/team-members/{userSub}` | Change a member's role | Organiser |
| DELETE | `/events/{eventId}/team-members/{userSub}` | Remove a member | Organiser |
| GET | `/events/{eventId}/team-members/{userSub}` | AuthZ check: does user hold role X (internal) | Service-to-service |
| POST | `/events/{eventId}/inventory/hold` | Reserve seats / quantity (soft lock) | Customer |
| POST | `/holds/{holdId}/release` | Release a hold | Customer / internal sweep |
| POST | `/holds/{holdId}/confirm` | Confirm a hold as sold (sync, no-oversell path) | Checkout Service |

---

### Schema installation and upgrades

For a new database, run `02-init-create-tables-index.sql`. It creates `events.total_seats` and the invitation lifecycle columns and index on `event_team_memberships`.

For an existing schema created before these fields were introduced, run the migrations once in order:

1. `03-add-event-team-invitations.sql` adds `invite_status`, nullable `responded_at`, and the `(user_sub, invite_status)` lookup index used for a user's inbox.
2. `04-add-event-total-seats.sql` adds the required event-capacity column with a default of `1` for existing rows.

`total_seats` is configured capacity on `events`; `inventory_items.total_qty`, `reserved_qty`, and `sold_qty` remain the operational quantities used to calculate currently available inventory.

On AWS, `05-grant-onestage-app-schema-access.sql` is also required once per MySQL instance — the ECS-hosted MySQL container only grants the app user access to its own `onestage` database on creation, not to any of the four schemas above. See `infrastructure/sql/QUICK-START.md`.

---

## Waiting Room / Queue Service — `queue` schema

Sits in front of Tier 2 on-sales only. Holds no inventory of its own — it just orders customers into a line and admits them in batches, checking availability against the Event & Inventory Service before letting anyone through.

### Data model

```mermaid
erDiagram
    QUEUE_SESSIONS ||--o{ QUEUE_ENTRIES : contains

    QUEUE_SESSIONS {
        bigint queue_session_id PK
        bigint event_id "logical ref -> event_inventory.events, no FK"
        datetime opens_at
        int admission_batch_size
        int admission_interval_sec
        enum status "CLOSED, OPEN, DRAINED"
    }
    QUEUE_ENTRIES {
        bigint queue_entry_id PK
        bigint queue_session_id FK
        varchar customer_sub "Cognito sub"
        bigint position
        enum status "WAITING, ADMITTED, IN_CHECKOUT, EXPIRED, LEFT"
        datetime joined_at
        datetime admitted_at "nullable"
        varchar admission_token "nullable"
        datetime token_expires_at "nullable"
    }
```

### Domain model

```mermaid
classDiagram
    class QueueSession {
        +Long queueSessionId
        +Long eventId
        +DateTime opensAt
        +int admissionBatchSize
        +int admissionIntervalSec
        +SessionStatus status
        +open()
        +drain()
    }
    class QueueEntry {
        +Long queueEntryId
        +Long queueSessionId
        +String customerSub
        +long position
        +EntryStatus status
        +DateTime joinedAt
        +DateTime admittedAt
        +String admissionToken
        +DateTime tokenExpiresAt
        +admit()
        +expire()
        +leave()
    }
    class SessionStatus {
        <<enumeration>>
        CLOSED
        OPEN
        DRAINED
    }
    class EntryStatus {
        <<enumeration>>
        WAITING
        ADMITTED
        IN_CHECKOUT
        EXPIRED
        LEFT
    }
    class WaitingRoomService {
        <<service>>
        +joinQueue(eventId, customerSub) QueueEntry
        +getMyStatus(eventId, customerSub) QueueEntry
        +admitNextBatch(queueSessionId)
        +configureSession(eventId, dto) QueueSession
    }

    QueueSession "1" *-- "0..*" QueueEntry : holds
    WaitingRoomService ..> QueueSession : manages
    WaitingRoomService ..> QueueEntry : manages
```

### API endpoints

| Method | Path | Description | Caller |
|---|---|---|---|
| PUT | `/events/{eventId}/queue/config` | Configure on-sale time & admission rate | Organiser |
| POST | `/events/{eventId}/queue/join` | Join the waiting room | Customer |
| GET | `/events/{eventId}/queue/me` | My live position & status | Customer |
| POST | `/events/{eventId}/queue/admit-next` | Admit the next batch (scheduled) | Internal (scheduled task) |

---

## Checkout & Payment Service — `checkout` schema

Turns a confirmed hold into a paid order using a simulated, tokenized payment — no real card data ever reaches this schema. Owns the sales figures and attendee contact details organisers see on their dashboard.

### Data model

```mermaid
erDiagram
    ORDERS ||--o{ ORDER_ITEMS : contains
    ORDERS ||--o{ PAYMENTS : "paid via"

    ORDERS {
        bigint order_id PK
        bigint event_id "logical ref -> event_inventory.events, no FK"
        varchar customer_sub "Cognito sub"
        varchar customer_email
        bigint hold_id "logical ref -> event_inventory.inventory_holds, no FK"
        enum status "PENDING, PAID, FAILED, CANCELLED"
        int total_amount_cents
        char currency
        datetime created_at
        datetime paid_at "nullable"
    }
    ORDER_ITEMS {
        bigint order_item_id PK
        bigint order_id FK
        bigint inventory_item_id "logical ref -> event_inventory.inventory_items, no FK"
        bigint seat_id "logical ref -> event_inventory.seats, nullable, no FK"
        varchar description
        int quantity
        int unit_price_cents
    }
    PAYMENTS {
        bigint payment_id PK
        bigint order_id FK
        varchar payment_token "simulated, tokenized"
        enum status "AUTHORIZED, CAPTURED, FAILED"
        int amount_cents
        datetime processed_at
    }
```

### Domain model

```mermaid
classDiagram
    class Order {
        +Long orderId
        +Long eventId
        +String customerSub
        +String customerEmail
        +Long holdId
        +OrderStatus status
        +int totalAmountCents
        +String currency
        +DateTime createdAt
        +DateTime paidAt
        +markPaid()
        +markFailed()
        +cancel()
    }
    class OrderItem {
        +Long orderItemId
        +Long orderId
        +Long inventoryItemId
        +Long seatId
        +String description
        +int quantity
        +int unitPriceCents
    }
    class Payment {
        +Long paymentId
        +Long orderId
        +String paymentToken
        +PaymentStatus status
        +int amountCents
        +DateTime processedAt
        +capture()
        +fail()
    }
    class OrderStatus {
        <<enumeration>>
        PENDING
        PAID
        FAILED
        CANCELLED
    }
    class PaymentStatus {
        <<enumeration>>
        AUTHORIZED
        CAPTURED
        FAILED
    }
    class CheckoutService {
        <<service>>
        +createOrder(eventId, holdId, customerSub) Order
        +submitPayment(orderId, simulatedCardToken) Payment
        +getOrder(orderId) Order
        +listMyOrders(customerSub) List~Order~
        +getSalesSummary(eventId) SalesSummary
        +publishOrderPaid(orderId)
    }

    Order "1" *-- "1..*" OrderItem : contains
    Order "1" *-- "1" Payment : paid via
    CheckoutService ..> Order : manages
    CheckoutService ..> Payment : manages
```

### API endpoints

| Method | Path | Description | Caller |
|---|---|---|---|
| POST | `/orders` | Create an order from a hold | Customer |
| POST | `/orders/{orderId}/payment` | Submit simulated, tokenized payment | Customer |
| GET | `/orders/{orderId}` | Order detail | Customer (owner) / Organiser |
| GET | `/customers/me/orders` | My order history | Customer |
| GET | `/events/{eventId}/orders/summary` | Sales dashboard data | Organiser / Helper |
| GET | `/events/{eventId}/attendees` | Attendee & order export | Organiser |

---

## Ticket Issuance & Validation Service — `ticketing` schema

Issues the QR-coded ticket after payment and is the single source of truth at the door: the Scanner App and the Buyer App's own "my tickets" view both read ticket state from here, so a ticket can never be checked in twice.

### Data model

```mermaid
erDiagram
    TICKETS ||--o{ CHECK_IN_LOGS : records

    TICKETS {
        bigint ticket_id PK
        bigint order_id "logical ref -> checkout.orders, no FK"
        bigint order_item_id "logical ref -> checkout.order_items, no FK"
        bigint event_id "logical ref -> event_inventory.events, no FK"
        varchar customer_sub "Cognito sub"
        varchar customer_email
        bigint seat_id "logical ref -> event_inventory.seats, nullable, no FK"
        varchar qr_token "unique"
        enum status "ISSUED, CHECKED_IN, VOID"
        datetime issued_at
        datetime checked_in_at "nullable"
        varchar checked_in_by_sub "nullable, Cognito sub"
    }
    CHECK_IN_LOGS {
        bigint log_id PK
        bigint ticket_id FK
        varchar scanned_by_sub "Cognito sub"
        enum result "SUCCESS, DUPLICATE, INVALID, WRONG_EVENT"
        datetime scanned_at
    }
```

### Domain model

```mermaid
classDiagram
    class Ticket {
        +Long ticketId
        +Long orderId
        +Long orderItemId
        +Long eventId
        +String customerSub
        +String customerEmail
        +Long seatId
        +String qrToken
        +TicketStatus status
        +DateTime issuedAt
        +DateTime checkedInAt
        +String checkedInBySub
        +checkIn(scannedBySub) CheckInResult
        +void()
    }
    class CheckInLog {
        +Long logId
        +Long ticketId
        +String scannedBySub
        +CheckInResult result
        +DateTime scannedAt
    }
    class TicketStatus {
        <<enumeration>>
        ISSUED
        CHECKED_IN
        VOID
    }
    class CheckInResult {
        <<enumeration>>
        SUCCESS
        DUPLICATE
        INVALID
        WRONG_EVENT
    }
    class TicketService {
        <<service>>
        +issueTicketsForOrder(orderPaidEvent) List~Ticket~
        +validateTicket(eventId, qrToken, scannedBySub) CheckInResult
        +searchTickets(eventId, query) List~Ticket~
        +getCheckInStats(eventId) CheckInStats
        +getMyTickets(customerSub) List~Ticket~
    }

    Ticket "1" *-- "0..*" CheckInLog : logs
    TicketService ..> Ticket : manages
    TicketService ..> CheckInLog : records
```

### API endpoints

| Method | Path | Description | Caller |
|---|---|---|---|
| GET | `/customers/me/tickets` | My tickets | Customer |
| GET | `/tickets/{ticketId}` | Ticket detail + QR | Customer (owner) |
| POST | `/tickets/validate` | Scan & validate a QR code | Helper / Organiser |
| GET | `/tickets/search` | Manual lookup by name / email / order ID | Helper / Organiser |
| GET | `/events/{eventId}/checkin-stats` | Live check-in count | Organiser / Helper |
| *(async)* | SQS `order-events` → `OrderPaid` | Consumer: issues ticket(s), then calls Notification Service | System |

---

## Notification Service — `notification` schema

Sends one confirmation email per issued ticket (event name, location, date/time, and that ticket's QR code) once Ticket Issuance has created the tickets for a paid order. It owns no inventory or money state — just the record of what was sent, to whom, and whether it succeeded — and delivers over Gmail SMTP via nodemailer.

### Data model

```mermaid
erDiagram
    EMAIL_NOTIFICATIONS {
        bigint notification_id PK
        bigint order_id "logical ref -> checkout.orders, no FK, indexed"
        bigint ticket_id "logical ref -> ticketing.tickets, no FK, unique, nullable"
        bigint event_id "logical ref -> event_inventory.events, no FK"
        varchar customer_sub "Cognito sub"
        varchar customer_email
        enum type "ORDER_CONFIRMATION"
        enum status "PENDING, SENT, FAILED"
        varchar subject
        text error_message "nullable"
        datetime sent_at "nullable"
        datetime created_at
    }
```

`ticket_id` carries a unique key, not just an index — it's what makes the send idempotent. A second call for the same ticket updates the existing row (`ON DUPLICATE KEY UPDATE`) instead of inserting a duplicate, while `order_id` is a plain index so one order can hold several rows. `ticket_id` is nullable only for rows written before per-ticket emails; MySQL allows any number of `NULL`s under a unique key. Apply `15-email-notifications-per-ticket.sql` to move an existing database to this shape.

### Domain model

```mermaid
classDiagram
    class EmailNotification {
        +Long notificationId
        +Long orderId
        +Long ticketId
        +Long eventId
        +String customerSub
        +String customerEmail
        +NotificationType type
        +NotificationStatus status
        +String subject
        +String errorMessage
        +DateTime sentAt
        +DateTime createdAt
    }
    class NotificationType {
        <<enumeration>>
        ORDER_CONFIRMATION
    }
    class NotificationStatus {
        <<enumeration>>
        PENDING
        SENT
        FAILED
    }
    class NotificationService {
        <<service>>
        +sendOrderConfirmation(dto) List~EmailNotification~
        +getNotifications(orderId) List~EmailNotification~
    }

    NotificationService ..> EmailNotification : manages
```

### API endpoints

| Method | Path | Description | Caller |
|---|---|---|---|
| POST | `/notifications/order-confirmation` | Send one confirmation email per ticket in the order and record one `email_notifications` row per ticket; idempotent on `ticketId` — tickets already `SENT` are skipped. Responds `{ orderId, notifications: [...] }`: 201 if any email was attempted, 200 if every ticket was already `SENT` | Ticket Issuance & Validation Service |
| GET | `/notifications/{orderId}` | Look up the send outcome (status, error, timestamps) of every ticket email for an order, for support/ops diagnosis; 404 if none | Not yet called by another service — read-only diagnostic route |

### Schema installation

Run `06-add-notification-schema.sql` once, in addition to `02-init-create-tables-index.sql`; it creates the `notification` database and the `email_notifications` table (`CREATE ... IF NOT EXISTS`, so it's safe to re-run). Afterward, re-run `05-grant-onestage-app-schema-access.sql` so `onestage_app` can reach the new schema too. On a database created before per-ticket emails, also run `15-email-notifications-per-ticket.sql` once (it checks `information_schema` first, so it's safe to re-run); it adds `ticket_id`, makes it the unique key, and demotes `order_id` to a plain index. The Notification Service needs it: its per-ticket queries fail with `Unknown column 'ticket_id'` until it has been applied.

---

## Tier 2 purchase — sync vs. async in one picture

The flow that justifies every choice above: the queue and the inventory hold are synchronous because correctness can't wait; publishing to SQS and issuing the ticket happen after the customer already has a confirmed, paid order.

```mermaid
sequenceDiagram
    actor C as Customer (Buyer App)
    participant WR as Waiting Room / Queue Service
    participant EIS as Event & Inventory Service
    participant CPS as Checkout & Payment Service
    participant SQS as SQS: order-events
    participant TIV as Ticket Issuance & Validation Service
    participant NS as Notification Service

    C->>WR: POST /queue/join
    WR-->>C: queue position (polls /queue/me)
    WR->>WR: admission worker admits next batch
    WR-->>C: ADMITTED + admission token

    C->>EIS: POST /inventory/hold (seats/qty, admission token)
    EIS->>EIS: reserve within DB transaction (no oversell)
    EIS-->>C: hold created, expiresAt

    C->>CPS: POST /orders (holdId)
    CPS-->>C: order PENDING
    C->>CPS: POST /orders/{id}/payment (simulated)
    CPS->>EIS: POST /holds/{id}/confirm  (sync — must succeed before order is PAID)
    EIS-->>CPS: hold CONFIRMED
    CPS->>CPS: mark order PAID
    CPS-->>C: order PAID
    CPS->>SQS: publish OrderPaid  (async — decouples issuance)
    SQS-->>TIV: deliver OrderPaid
    TIV->>TIV: issue ticket(s), generate QR tokens
    TIV->>NS: POST /notifications/order-confirmation (not awaited, idempotent per ticketId)
    NS->>NS: per ticket: render QR image, send via Gmail SMTP, insert email_notifications row
    NS-->>C: one confirmation email per ticket, each with its QR code (async delivery)
```

A Tier 1 purchase runs the same path with the Waiting Room steps skipped entirely — `POST /inventory/hold` succeeds immediately since there's no queue to admit from.

---

*Companion document to "OneStage — User Stories & Use-Case Diagrams." IDs, enum values, and endpoint names here are the vocabulary the user stories' acceptance criteria assume — e.g. CU-09's "no seat is ever confirmed to two buyers" is exactly what `InventoryHold` plus the synchronous `/holds/{id}/confirm` call is designed to guarantee.*
