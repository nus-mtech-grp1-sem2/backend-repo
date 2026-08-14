---
name: ecs-capacity-review
description: Review OneStage ECS-on-EC2 capacity providers, service autoscaling, ALB signals, ASG bounds, and flash-crowd readiness; use for compute capacity decisions, not Fargate, EKS, or routine application code.
---
# ECS capacity review

Inspect task definitions, services, capacity provider and ASG settings, scaling policies, ALB metrics, k6 evidence, quotas, costs, and failure history. Do not use for Fargate, EKS, or routine application code.

1. Verify ECS service autoscaling controls tasks while capacity-provider managed scaling controls EC2 nodes; reject competing direct ASG scaling policies.
2. Prefer ALB requests per target for synchronous HTTP demand, backlog per task for workers, and CPU/memory as guardrails. Review cooldowns, warm capacity, scheduled pre-scaling, managed termination protection, and draining.
3. Require waiting-room admission control, rate limiting, queueing, On-Demand capacity for critical demonstrations, cost ceilings, and Budgets alerts. Spot must be optional for critical paths.
4. Assess security, reliability, scalability, performance, cost, and operational response; use k6 evidence to justify task/ASG limits and thresholds.
5. Never claim a test passed unless it executed successfully. Never implicitly authorize secret access, scaling changes, deployment, or destructive infrastructure operations; require human approval.
