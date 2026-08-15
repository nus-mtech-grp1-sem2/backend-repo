---
name: api-contract-change
description: Review or implement OneStage OpenAPI, Swagger, HTTP, and event contract changes for documentation, compatibility, validation, versioning, clients, and rollout; use when endpoints, requests, responses, errors, or event schemas change, not for internal refactors with no contract effect.
---
# API contract change

Inspect the OpenAPI document or Swagger annotations, routes, DTOs, runtime validation, authentication and authorization, consumers, generated clients, tests, and deployed-version assumptions before recommending changes. Do not use for internal refactors that cannot affect a contract.

1. Classify the change as compatible, conditionally compatible, or breaking; cover errors, nullability, defaults, pagination, idempotency, authentication, and content types.
2. For backend HTTP changes, update the canonical OpenAPI 3.x operation and reusable schemas in the same change. Document operation ID, summary, parameters, security, request body, success and error responses, status codes, and sanitized examples; keep annotations consistent with runtime behavior.
3. For frontend API changes, inspect the published OpenAPI contract and update generated clients, types, mocks, and contract tests where established. Do not add server-side Swagger annotations to Angular code.
4. Prefer additive evolution. For breaking changes, require explicit versioning, migration, dual-read/write or compatibility window, owner, and rollback plan.
5. Assess security including authorization, documentation exposure, and example data; assess reliability, scalability, payload and latency performance, cost, and operational observability.
6. Validate the OpenAPI document, unresolved references, operation ID uniqueness, and backward compatibility, then run repository-defined producer-consumer contract tests.
7. Never claim a test passed unless it executed successfully. Never implicitly authorize secret access, public Swagger UI exposure, deployment, destructive migration, or consumer cutoff; require human approval.
