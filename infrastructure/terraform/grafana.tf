# Read-only cross-account role for Grafana Cloud's CloudWatch data source
# (Grafana Cloud UI: Connections > Amazon CloudWatch > Authentication >
# "Grafana Assume Role" > "How to create an IAM role for Grafana to assume").
# That page is the only source for grafana_aws_account_id/grafana_external_id
# -- they don't exist until the data source has been created on Grafana's
# side, so this whole role is gated off (count = 0) until both variables are
# set via -var or a tfvars file.
locals {
  grafana_cloudwatch_enabled = var.grafana_aws_account_id != "" && var.grafana_external_id != ""
}

data "aws_iam_policy_document" "grafana_cloudwatch_trust" {
  count = local.grafana_cloudwatch_enabled ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.grafana_aws_account_id}:root"]
    }

    # The external ID is what stops any other Grafana Cloud customer's stack
    # (all of which share the same trusted account ID) from assuming this role.
    condition {
      test     = "StringEquals"
      variable = "sts:ExternalId"
      values   = [var.grafana_external_id]
    }
  }
}

resource "aws_iam_role" "grafana_cloudwatch" {
  count              = local.grafana_cloudwatch_enabled ? 1 : 0
  name               = "${local.name_prefix}-grafana-cloudwatch-readonly"
  assume_role_policy = data.aws_iam_policy_document.grafana_cloudwatch_trust[0].json
}

# Grafana's documented CloudWatch data source policy, trimmed of the
# Performance Insights statement (pi:GetResourceMetrics) since this stack has
# no RDS -- everything below is read-only, nothing can write, delete, or
# reach a service outside CloudWatch/EC2-describe/tag-discovery.
data "aws_iam_policy_document" "grafana_cloudwatch_permissions" {
  count = local.grafana_cloudwatch_enabled ? 1 : 0

  statement {
    sid    = "AllowReadingMetricsFromCloudWatch"
    effect = "Allow"
    actions = [
      "cloudwatch:DescribeAlarmsForMetric",
      "cloudwatch:DescribeAlarmHistory",
      "cloudwatch:DescribeAlarms",
      "cloudwatch:ListMetrics",
      "cloudwatch:GetMetricData",
      "cloudwatch:GetInsightRuleReport",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "AllowReadingLogsFromCloudWatch"
    effect = "Allow"
    actions = [
      "logs:DescribeLogGroups",
      "logs:GetLogGroupFields",
      "logs:StartQuery",
      "logs:StopQuery",
      "logs:GetQueryResults",
      "logs:GetLogEvents",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "AllowReadingTagsAndRegionsFromEC2"
    effect    = "Allow"
    actions   = ["ec2:DescribeTags", "ec2:DescribeInstances", "ec2:DescribeRegions"]
    resources = ["*"]
  }

  statement {
    sid       = "AllowReadingResourcesForTags"
    effect    = "Allow"
    actions   = ["tag:GetResources"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "grafana_cloudwatch" {
  count  = local.grafana_cloudwatch_enabled ? 1 : 0
  name   = "cloudwatch-read-only"
  role   = aws_iam_role.grafana_cloudwatch[0].id
  policy = data.aws_iam_policy_document.grafana_cloudwatch_permissions[0].json
}

output "grafana_cloudwatch_role_arn" {
  description = "Paste into Grafana Cloud's CloudWatch data source > Assume Role ARN field."
  value       = local.grafana_cloudwatch_enabled ? aws_iam_role.grafana_cloudwatch[0].arn : null
  # The ARN itself isn't sensitive, but it's derived from a condition on
  # grafana_external_id (marked sensitive in variables.tf), which taints it.
  sensitive = true
}
