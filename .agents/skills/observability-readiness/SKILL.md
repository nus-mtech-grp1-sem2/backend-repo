---
name: observability-readiness
description: Review OneStage metrics, logs, traces, dashboards, Prometheus rules, and alerts for release and operational readiness; use for behavior or infrastructure changes, not cosmetic dashboard-only requests without a service objective.
---
# Observability readiness

Inspect service objectives, failure modes, instrumentation, dashboards, Prometheus rules, runbooks, ownership, and deployment topology. Do not use for cosmetic dashboards without an operational objective.

1. Cover request rate, errors, duration, saturation, business correctness, dependency health, ECS tasks/nodes, ALB, RDS, queue backlog, and scaling events.
2. Use bounded-cardinality labels, structured redacted logs, trace propagation, actionable alerts, burn-rate or symptom-based signals, and links to runbooks.
3. Assess security and sensitive telemetry, reliability, scalability, query/storage performance, ingestion cost, and on-call operational burden.
4. Validate Prometheus rules with `promtool` when available and exercise alert conditions or unit tests; verify dashboards against real metric names.
5. Never claim a test passed unless it executed successfully. Never implicitly authorize secret access, production changes, alert silencing, deployment, or destructive telemetry actions; require human approval.
