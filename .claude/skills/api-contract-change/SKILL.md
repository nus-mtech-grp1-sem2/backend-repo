---
name: api-contract-change
description: Review or implement OneStage HTTP and event contract changes for compatibility, validation, versioning, clients, and rollout; use when request, response, error, or event schemas change, not for internal refactors with no contract effect.
---
# API contract change

Inspect API schemas, routes, DTOs, consumers, generated clients, tests, and deployed-version assumptions before recommending changes. Do not use for internal refactors that cannot affect a contract.

1. Classify the change as compatible, conditionally compatible, or breaking; cover errors, nullability, defaults, pagination, idempotency, and content types.
2. Prefer additive evolution. For breaking changes, require explicit versioning, migration, dual-read/write or compatibility window, owner, and rollback plan.
3. Assess security including authorization and data exposure, reliability, scalability, payload and latency performance, cost, and operational observability.
4. Verify schema/contract tests and relevant producer-consumer integration tests using repository-defined commands.
5. Never claim a test passed unless it executed successfully. Never implicitly authorize secret access, deployment, destructive migration, or consumer cutoff; require human approval.
