# OneStage AWS infrastructure

Terraform for the whole deployed stack (backend ECS services + Kong + MySQL,
and the `core-frontend` S3/CloudFront hosting) — one root module, one state,
one `terraform apply`. See `~/.claude/plans/snazzy-stargazing-liskov.md` (or
the equivalent design doc) for the full architecture rationale.

## One-time setup

1. **State bucket** (must exist before `terraform init`):
   ```
   ../../scripts/bootstrap-backend.sh
   ```
2. **Init**:
   ```
   terraform init -backend-config=backend.hcl
   ```
3. **First apply** — `create_services` defaults to `false` so ECS services
   aren't created before real images exist in ECR:
   ```
   terraform apply
   ```
4. **Push real images** — trigger `deploy-backend.yml` once via
   `workflow_dispatch` in GitHub Actions (its `deploy` job will fail at this
   point since services don't exist yet — that's expected; only the
   `build-and-push` job matters here).
5. **Create the services**:
   ```
   terraform apply -var="create_services=true"
   ```

## Required GitHub Actions repo variables (not secrets — OIDC needs none)

After step 3/5's apply, read the outputs and set these as **Variables** (not
Secrets) in each repo's GitHub settings:

| Repo | Variable | Value (from `terraform output`) |
|---|---|---|
| backend-repo | `AWS_DEPLOY_ROLE_ARN` | `github_deploy_backend_role_arn` |
| core-frontend | `AWS_DEPLOY_ROLE_ARN` | `github_deploy_frontend_role_arn` |
| core-frontend | `FRONTEND_BUCKET` | `frontend_bucket_name` |
| core-frontend | `CLOUDFRONT_DISTRIBUTION_ID` | `cloudfront_distribution_id` |

Both `deploy-backend.yml` and `deploy-frontend.yml` gate their live-update
step behind a GitHub `production` Environment — create that environment in
each repo's settings with a required reviewer before merging.

## Day-to-day

- `../../scripts/start-env.sh` / `stop-env.sh` — scale the whole environment
  up/down for a work or demo session. A nightly EventBridge schedule
  (`scale_schedule.tf`) force-scales to 0 regardless, as a budget safety net.
- Every `terraform apply`/`destroy` is manual and reviewed locally first —
  no CI auto-apply. `terraform-ci.yml` only runs fmt/validate/tflint/tfsec
  on PRs, never applies.

## Known deviations from the internal governance skills, deliberate

- **MySQL runs as a container on ECS, not RDS** (`ecs-capacity-review` skill
  prefers private RDS) — cost tradeoff for an MVP where the `DB_*` env vars
  aren't wired into any service code yet. Needs a followup ADR.
- **Classic ASG-backed `aws_ecs_capacity_provider`, not ECS Managed
  Instances** — the originally-chosen approach, reverted because
  `hashicorp/aws` has open unresolved bugs managing Managed Instances via
  Terraform (issues #44783, #45693 as of this writing). Revisit once those
  are resolved if a "true" Managed Instances setup matters for the writeup.
