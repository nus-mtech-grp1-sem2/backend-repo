---
name: aws-terraform-change
description: Govern AWS Terraform module and validation changes for OneStage without creating live environments or state; use for IaC design and review, not application-only changes or deployment execution.
---
# AWS Terraform change

Inspect Terraform versions, providers, modules, variables, validation CI, account/environment conventions, and documentation. Do not use for application-only work or execute deployment actions.

1. Keep state remote, encrypted, locked, and uncommitted. Require explicit account, region, workspace, and environment targeting.
2. Enforce least-privilege IAM, OIDC for CI, restricted networks, private RDS, encryption, backups, tags, capacity bounds, budgets, and safe deletion protection.
3. Assess security, failure domains and reliability, scalability, performance, cost delta, drift, rollback, and operational ownership.
4. Run `terraform fmt -check`, initialization without backend where feasible, `terraform validate`, TFLint, and established security scanners; redact sensitive plan values.
5. Never claim a test passed unless it executed successfully. Never implicitly authorize secrets, apply/destroy/import/state operations, IAM/network changes, or deployment; require human approval.
