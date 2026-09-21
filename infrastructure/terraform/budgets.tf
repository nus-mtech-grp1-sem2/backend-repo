# Customer-managed key so the account owns/rotates the encryption key instead
# of depending on the AWS-managed alias/aws/sns key (~$1/mo). AWS Budgets
# publishes to this topic as a service principal, not an IAM role, so it
# needs an explicit grant here -- a CMK's default policy only trusts the
# account root, unlike the AWS-managed key's built-in per-service trust.
resource "aws_kms_key" "sns_budget_alerts" {
  description         = "CMK for ${local.name_prefix} budget alert SNS topic"
  enable_key_rotation = true

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EnableRootPermissions"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${var.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "AllowBudgetsToUseKey"
        Effect    = "Allow"
        Principal = { Service = "budgets.amazonaws.com" }
        Action    = ["kms:Decrypt", "kms:GenerateDataKey*"]
        Resource  = "*"
      }
    ]
  })
}

resource "aws_kms_alias" "sns_budget_alerts" {
  name          = "alias/${local.name_prefix}-budget-alerts"
  target_key_id = aws_kms_key.sns_budget_alerts.key_id
}

resource "aws_sns_topic" "budget_alerts" {
  name              = "${local.name_prefix}-budget-alerts"
  kms_master_key_id = aws_kms_key.sns_budget_alerts.id
}

resource "aws_sns_topic_subscription" "budget_alerts_email" {
  topic_arn = aws_sns_topic.budget_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

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
    subscriber_email_addresses = [var.alert_email]
    subscriber_sns_topic_arns  = [aws_sns_topic.budget_alerts.arn]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
    subscriber_sns_topic_arns  = [aws_sns_topic.budget_alerts.arn]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
    subscriber_sns_topic_arns  = [aws_sns_topic.budget_alerts.arn]
  }

  # Hard ceiling — expressed as a % of the $50 target that lands on $100.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = (var.budget_ceiling_usd / var.budget_target_usd) * 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
    subscriber_sns_topic_arns  = [aws_sns_topic.budget_alerts.arn]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
    subscriber_sns_topic_arns  = [aws_sns_topic.budget_alerts.arn]
  }
}
