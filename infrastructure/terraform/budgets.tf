# The account's only budget. Alerts go straight to each team member's inbox:
# Budgets emails need no confirmation step (an SNS email subscription stays
# silent until its owner clicks the link) and carry the budget details. AWS
# allows at most 10 email subscribers per notification, which is why
# alert_emails is capped at 10 (variables.tf). Anyone new joining the team
# must be added to alert_emails in terraform.tfvars and applied; nothing ties
# this list to IAM Identity Center.
resource "aws_budgets_budget" "monthly" {
  name         = "${local.name_prefix}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_target_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.alert_emails
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.alert_emails
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.alert_emails
  }

  # Hard ceiling — expressed as a % of the $50 target that lands on $100.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = (var.budget_ceiling_usd / var.budget_target_usd) * 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.alert_emails
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = var.alert_emails
  }
}
