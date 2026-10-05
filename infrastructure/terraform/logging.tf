# Shared destination for CloudFront + S3 access logs (tfsec:
# cloudfront-set-access-logging, s3-enable-bucket-logging). One bucket for
# both rather than two -- neither needs isolation from the other and it
# halves the setup.
#
# CloudFront's standard logging still only supports delivery via S3 ACLs,
# not a bucket policy alone -- it needs the bucket to have ACLs enabled
# (BucketOwnerPreferred, not the modern BucketOwnerEnforced default) and the
# `log-delivery-write` canned ACL granted to CloudFront's log delivery
# group. S3-to-S3 access logging (the frontend bucket's own logs) separately
# needs a bucket policy granting logging.s3.amazonaws.com s3:PutObject. Both
# delivery mechanisms require SSE-S3 (AES256) on the destination bucket --
# SSE-KMS breaks log delivery for both -- so this bucket intentionally stays
# off the CMK pattern used elsewhere in this stack.
resource "aws_s3_bucket" "access_logs" {
  bucket = "${local.name_prefix}-access-logs-${var.account_id}"
}

resource "aws_s3_bucket_versioning" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "access_logs" {
  bucket                  = aws_s3_bucket.access_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# 30 days -- these are debug/investigation logs, not an audit requirement,
# so unbounded growth isn't worth paying for on a course project.
resource "aws_s3_bucket_lifecycle_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    id     = "expire-after-30-days"
    status = "Enabled"
    filter {}
    expiration {
      days = 30
    }
  }
}

resource "aws_s3_bucket_ownership_controls" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    object_ownership = "BucketOwnerPreferred" # ACLs enabled -- required for CloudFront log delivery below
  }
}

resource "aws_s3_bucket_acl" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  acl    = "log-delivery-write" # grants CloudFront's log-delivery group WRITE + READ_ACP

  depends_on = [aws_s3_bucket_ownership_controls.access_logs, aws_s3_bucket_public_access_block.access_logs]
}

data "aws_iam_policy_document" "access_logs_bucket" {
  statement {
    sid       = "AllowS3LoggingServicePrincipal"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.access_logs.arn}/s3-frontend/*"]

    principals {
      type        = "Service"
      identifiers = ["logging.s3.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
  }
}

resource "aws_s3_bucket_policy" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  policy = data.aws_iam_policy_document.access_logs_bucket.json
}

# --- VPC Flow Logs ----------------------------------------------------------

# AWS-managed encryption rather than a customer-managed KMS key (~US$1/month and
# a key policy to maintain) for flow-log metadata.
#tfsec:ignore:aws-cloudwatch-log-group-customer-key
resource "aws_cloudwatch_log_group" "vpc_flow_logs" {
  name              = "/vpc/${local.name_prefix}/flow-logs"
  retention_in_days = 90 # investigation window; storage cost at this log volume is negligible either way
}

data "aws_iam_policy_document" "vpc_flow_logs_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "vpc_flow_logs" {
  name               = "${local.name_prefix}-vpc-flow-logs"
  assume_role_policy = data.aws_iam_policy_document.vpc_flow_logs_trust.json
}

# The :* suffix is the log streams inside this one log group, which is the
# narrowest ARN CreateLogStream/PutLogEvents accept.
#tfsec:ignore:aws-iam-no-policy-wildcards
data "aws_iam_policy_document" "vpc_flow_logs_permissions" {
  statement {
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogGroups",
      "logs:DescribeLogStreams",
    ]
    resources = ["${aws_cloudwatch_log_group.vpc_flow_logs.arn}:*"]
  }
}

resource "aws_iam_role_policy" "vpc_flow_logs" {
  name   = "publish"
  role   = aws_iam_role.vpc_flow_logs.id
  policy = data.aws_iam_policy_document.vpc_flow_logs_permissions.json
}

resource "aws_flow_log" "vpc" {
  vpc_id               = aws_vpc.main.id
  traffic_type         = "ALL"
  log_destination_type = "cloud-watch-logs"
  log_destination      = aws_cloudwatch_log_group.vpc_flow_logs.arn
  iam_role_arn         = aws_iam_role.vpc_flow_logs.arn

  tags = { Name = "${local.name_prefix}-vpc-flow-log" }
}
