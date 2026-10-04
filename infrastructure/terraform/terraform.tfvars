# create_services defaults to false in variables.tf so the very first apply
# (networking/ECR/IAM/ALB, before any images exist) doesn't try to launch
# task definitions that reference images that don't exist yet. Once past
# that bootstrap point, this MUST be true — otherwise a bare `terraform
# plan`/`apply` silently reverts to destroying all 9 services and their
# scheduler resources. Persisting it here (not just as a one-off -var flag)
# is the fix: a forgotten -var flag nearly did exactly that.
create_services = true

# Budget alert recipients (budgets.tf): the team's NUS and personal addresses.
# AWS caps this at 10, so drop an address before adding one.
alert_emails = [
  "callumiscoding@gmail.com",
  "callumtan@u.nus.edu",
  "fcyong519@hotmail.com",
  "foochuanyong@u.nus.edu",
  "rohini.vinothkannan@u.nus.edu",
  "rohiniramasamy266@gmail.com",
  "rubyferdianto@u.nus.edu",
  "songming.law@u.nus.edu",
  "sonepyie@gmail.com",
  "sonnypyiesone@u.nus.edu",
]
