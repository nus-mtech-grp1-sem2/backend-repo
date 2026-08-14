---
name: node-service-change
description: Govern OneStage Node.js and TypeScript service changes across handlers, domain logic, persistence, jobs, and runtime behavior; use for backend implementation or review, not frontend-only or Terraform-only work.
---
# Node service change

Inspect `package.json`, the lockfile, TypeScript and lint configs, service boundaries, tests, Dockerfile, and CI before editing. Do not use for frontend-only or Terraform-only work.

1. Preserve the detected runtime, package manager, framework, module system, test runner, and error conventions; never invent commands.
2. Validate inputs and outputs, timeouts, retries, idempotency, concurrency, cancellation, graceful shutdown, and structured error handling.
3. Assess security including authentication, authorization, injection, and secret risks; assess reliability, scalability, performance, cost, and operational impact.
4. Run the narrowest test, then repository-defined lint, format, type-check, unit/integration tests, build, and dependency audit when present.
5. Report evidence and uncertainty. Never claim a test passed unless it executed successfully. Never implicitly authorize secrets, deployment, migration, or destructive operations; require human approval.
