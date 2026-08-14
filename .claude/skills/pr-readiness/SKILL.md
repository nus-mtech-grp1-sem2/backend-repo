---
name: pr-readiness
description: Assess OneStage changes for pull-request readiness across scope, evidence, compatibility, risk, documentation, and rollout; use before review or merge, not to bypass required reviewers, checks, or branch protection.
---
# PR readiness

Inspect the full diff, status, repository instructions, issue/ADR context, tests, CI, dependencies, generated files, and documentation. Do not use to bypass required review, checks, or branch protection.

1. Confirm the change is minimal and coherent, generated content is synchronized, title is conventional, and description covers intent, validation, risks, rollout, and rollback.
2. Check compatibility, migrations, dependency justification, secret exposure, least privilege, and ownership of operational changes.
3. Assess security, reliability, scalability, performance, cost, and operational impact; identify blocking versus follow-up findings.
4. Run the narrowest verification then all repository-required checks. Record commands, successful results, failures, skipped checks, and reasons.
5. Never claim a test passed unless it executed successfully. Never implicitly authorize secret access, merge, deployment, migration, IAM/networking, or destructive operations; require human approval.
