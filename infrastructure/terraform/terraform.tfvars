# create_services defaults to false in variables.tf so the very first apply
# (networking/ECR/IAM/ALB, before any images exist) doesn't try to launch
# task definitions that reference images that don't exist yet. Once past
# that bootstrap point, this MUST be true — otherwise a bare `terraform
# plan`/`apply` silently reverts to destroying all 9 services and their
# scheduler resources. Persisting it here (not just as a one-off -var flag)
# is the fix: a forgotten -var flag nearly did exactly that.
create_services = true
