---
name: k6-load-test
description: Design, review, and interpret safe k6 tests for OneStage smoke, load, stress, and ticket-sale scenarios; use for performance validation, not production load generation without explicit authorization.
---
# k6 load test

Inspect service objectives, traffic shape, endpoints, test data, environment limits, existing k6 scripts, dashboards, and prior results. Do not use this skill to target production or third parties without explicit authorization.

1. Model arrival rates, user journeys, correlation, think time, waiting-room behavior, and cleanup; avoid coordinated omission and unbounded cardinality.
2. Define thresholds for correctness and latency, staged abort criteria, capacity ceilings, and a safe test-data strategy with no real credentials.
3. Assess security, reliability and overload containment, scalability, performance bottlenecks, test and cloud cost, and operational monitoring.
4. Run syntax or smoke validation first, then authorized load stages; correlate ALB, ECS, ASG, RDS, application, and queue metrics.
5. Never claim a test passed unless it executed successfully. Never implicitly authorize secrets, production traffic, deployment, destructive cleanup, or quota/capacity changes; require human approval.
