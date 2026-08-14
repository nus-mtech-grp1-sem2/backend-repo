---
name: adr-authoring
description: Author or revise OneStage architecture decision records with context, options, evidence, consequences, and review status; use for durable cross-cutting decisions, not minor implementation details or already-settled facts.
---
# ADR authoring

Inspect existing ADRs, architecture, constraints, measurements, ownership, and affected repositories before drafting. Do not use this skill for minor implementation details or present proposals as accepted.

1. Capture context, decision drivers, considered options, decision/status, consequences, risks, rollout, rollback, and review date. Separate evidence from assumptions.
2. Make security, reliability, scalability, performance, cost, operational ownership, compatibility, and migration impacts explicit.
3. Link verifiable sources and state unresolved decisions. Prefer reversible decisions and measurable success criteria.
4. Validate Markdown and diagrams; confirm referenced artifacts exist. Require human review for status changes.
5. Never claim a test passed unless it executed successfully. Never implicitly authorize secret access, deployment, migration, IAM/networking, or destructive operations; require human approval.
