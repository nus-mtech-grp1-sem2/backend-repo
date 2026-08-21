# Nightly safety net: force every ECS service's desired count to 0 even if
# someone forgot to run scripts/stop-env.sh. Once every service is at 0, the
# capacity provider's own managed scaling (autoscaling_capacity.tf,
# target_capacity=100) naturally drains the ASG to 0 too — no separate
# ASG-zeroing schedule needed. This is the main defense against an
# accidentally-left-running environment burning through the $100 ceiling.

data "aws_iam_policy_document" "scheduler_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scale_to_zero" {
  count              = var.create_services ? 1 : 0
  name               = "${local.name_prefix}-scale-to-zero"
  assume_role_policy = data.aws_iam_policy_document.scheduler_trust.json
}

data "aws_iam_policy_document" "scale_to_zero_permissions" {
  statement {
    effect  = "Allow"
    actions = ["ecs:UpdateService"]
    resources = [
      for name in concat(keys(local.services), ["mysql"]) :
      "arn:aws:ecs:${var.region}:${var.account_id}:service/${aws_ecs_cluster.main.name}/${local.name_prefix}-${name}"
    ]
  }
}

resource "aws_iam_role_policy" "scale_to_zero" {
  count  = var.create_services ? 1 : 0
  name   = "update-service"
  role   = aws_iam_role.scale_to_zero[0].id
  policy = data.aws_iam_policy_document.scale_to_zero_permissions.json
}

resource "aws_scheduler_schedule" "scale_to_zero" {
  for_each = var.create_services ? toset(concat(keys(local.services), ["mysql"])) : []

  name                         = "${local.name_prefix}-scale-to-zero-${each.value}"
  schedule_expression          = "cron(0 23 * * ? *)" # 23:00 daily
  schedule_expression_timezone = "Asia/Singapore"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = "arn:aws:scheduler:::aws-sdk:ecs:updateService"
    role_arn = aws_iam_role.scale_to_zero[0].arn

    input = jsonencode({
      Cluster      = aws_ecs_cluster.main.name
      Service      = "${local.name_prefix}-${each.value}"
      DesiredCount = 0
    })
  }
}
