---
name: database-migration-review
description: Review RDS MySQL schema and data migrations for online safety, compatibility, rollback, locking, and recovery; use for DDL, backfills, index changes, or ORM migrations, not ordinary query-only changes.
---
# Database migration review

Inspect schema, migration framework, query paths, table sizes or available estimates, RDS settings, backups, and deployment ordering. Do not use for ordinary query-only changes.

1. Identify locks, table rebuilds, replication lag, long transactions, disk growth, and version-specific MySQL behavior; do not assume online DDL.
2. Require expand/migrate/contract sequencing, idempotent resumable backfills, bounded batches, observability, abort criteria, tested restoration, and backward-compatible application rollout.
3. Assess security including credentials and sensitive data, reliability, scalability, query performance, RDS/storage cost, and operational ownership.
4. Verify syntax in a disposable compatible database and test forward/rollback or roll-forward procedures where safe.
5. Never claim a test passed unless it executed successfully. Never run or authorize production DDL, data deletion, secret access, or restoration implicitly; require explicit human approval.
