---
name: incident-diagnosis
description: Diagnose OneStage production-like incidents hypothesis-first using logs, metrics, traces, configuration, changes, and runtime evidence; use for active or retrospective failures, not unapproved remediation or destructive experiments.
---
# Incident diagnosis

Inspect symptoms, timeline, scope, recent changes, logs, metrics, traces, configs, quotas, dependencies, and known runbooks. Do not use this skill to perform unapproved remediation or destructive experiments.

1. State ranked hypotheses with confirming and rejecting evidence. Establish user impact and containment options before root-cause claims.
2. Correlate ALB, ECS services/tasks, capacity provider/ASG, EC2, RDS, queues, application, and deployment events; preserve timestamps and evidence integrity.
3. Assess security indicators, reliability and failure domains, scalability saturation, performance, cost anomalies, and operational recovery risk.
4. Prefer read-only commands; record every query and limitation. Verify recovery through service-level and business signals, not a single green metric.
5. Never claim a test or recovery passed unless it executed successfully. Never implicitly authorize secrets, failover, restart, scaling, rollback, deployment, data repair, or destructive action; require human approval.
