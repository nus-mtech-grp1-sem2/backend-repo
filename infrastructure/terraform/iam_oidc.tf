resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]
}

# --- Backend deploy role ---------------------------------------------------

data "aws_iam_policy_document" "github_backend_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # This org has GitHub's immutable-ID subject claims enabled, so the
    # actual sub is "repo:org@<org-id>/repo@<repo-id>:ref:refs/heads/main",
    # not the plain "repo:org/repo:..." format most examples assume.
    # StringLike + wildcard on the id suffix avoids hardcoding IDs that
    # would break if this repo were ever transferred.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_org}@*/${var.backend_repo_name}@*:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "github_deploy_backend" {
  name               = "${local.name_prefix}-github-deploy-backend"
  assume_role_policy = data.aws_iam_policy_document.github_backend_trust.json
}

data "aws_iam_policy_document" "github_deploy_backend_permissions" {
  statement {
    sid       = "EcrAuth"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "EcrPushPull"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "ecr:PutImage",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
    ]
    resources = [
      aws_ecr_repository.backend.arn,
      aws_ecr_repository.kong.arn,
    ]
  }

  statement {
    sid       = "EcsRegisterTaskDef"
    effect    = "Allow"
    actions   = ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition"]
    resources = ["*"] # RegisterTaskDefinition doesn't support resource-level scoping
  }

  statement {
    sid     = "EcsUpdateServices"
    effect  = "Allow"
    actions = ["ecs:UpdateService", "ecs:DescribeServices"]
    resources = [
      for name in keys(local.services) : "arn:aws:ecs:${var.region}:${var.account_id}:service/${aws_ecs_cluster.main.name}/${local.name_prefix}-${name}"
    ]
  }

  statement {
    sid       = "PassEcsRoles"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.ecs_task_execution.arn, aws_iam_role.ecs_task.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "github_deploy_backend" {
  name   = "deploy"
  role   = aws_iam_role.github_deploy_backend.id
  policy = data.aws_iam_policy_document.github_deploy_backend_permissions.json
}

# --- Frontend deploy role ---------------------------------------------------

data "aws_iam_policy_document" "github_frontend_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_org}@*/${var.frontend_repo_name}@*:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "github_deploy_frontend" {
  name               = "${local.name_prefix}-github-deploy-frontend"
  assume_role_policy = data.aws_iam_policy_document.github_frontend_trust.json
}

data "aws_iam_policy_document" "github_deploy_frontend_permissions" {
  statement {
    sid    = "S3Sync"
    effect = "Allow"
    # tfsec:ignore:aws-iam-no-policy-wildcards -- the /* suffix is required
    # for S3 object-level actions (PutObject/DeleteObject apply to objects,
    # not the bucket itself); this is scoped to exactly one named bucket,
    # not a wildcarded set of resources.
    actions   = ["s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.frontend.arn, "${aws_s3_bucket.frontend.arn}/*"]
  }

  statement {
    sid       = "CloudFrontInvalidate"
    effect    = "Allow"
    actions   = ["cloudfront:CreateInvalidation"]
    resources = [aws_cloudfront_distribution.frontend.arn]
  }
}

resource "aws_iam_role_policy" "github_deploy_frontend" {
  name   = "deploy"
  role   = aws_iam_role.github_deploy_frontend.id
  policy = data.aws_iam_policy_document.github_deploy_frontend_permissions.json
}
