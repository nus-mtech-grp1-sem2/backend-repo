data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Pulls images from ECR + writes to CloudWatch Logs on the platform's behalf.
resource "aws_iam_role" "ecs_task_execution" {
  name               = "${local.name_prefix}-ecs-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# The managed policy above covers ECR pull + CloudWatch Logs only — it does
# NOT include Secrets Manager access. The mysql task definition injects
# secrets via `secrets` (ecs_mysql.tf), which the execution role fetches on
# the task's behalf, so it needs explicit read access to that one secret.
data "aws_iam_policy_document" "ecs_task_execution_secrets" {
  statement {
    sid       = "ReadMysqlSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.mysql.arn]
  }
}

resource "aws_iam_role_policy" "ecs_task_execution_secrets" {
  name   = "read-mysql-secret"
  role   = aws_iam_role.ecs_task_execution.id
  policy = data.aws_iam_policy_document.ecs_task_execution_secrets.json
}

# Application-level task role, assumed by the running containers themselves.
# Only the auth service currently calls AWS APIs at runtime (Cognito, via
# @aws-sdk/client-cognito-identity-provider) — everything else gets no AWS
# permissions at all.
resource "aws_iam_role" "ecs_task" {
  name               = "${local.name_prefix}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

data "aws_iam_policy_document" "ecs_task_permissions" {
  # Scoped to the specific user pool already hardcoded in core-frontend's
  # app.config.ts. Covers the common admin/lookup operations an auth service
  # typically needs; tighten to the exact set once services/auth/src is
  # reviewed against this list.
  statement {
    sid    = "CognitoAuthOperations"
    effect = "Allow"
    actions = [
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminAddUserToGroup",
      "cognito-idp:AdminListGroupsForUser",
      "cognito-idp:ListUsers",
    ]
    resources = ["arn:aws:cognito-idp:${var.region}:${var.account_id}:userpool/ap-southeast-1_cgmx4fpO2"]
  }
}

resource "aws_iam_role_policy" "ecs_task" {
  name   = "cognito"
  role   = aws_iam_role.ecs_task.id
  policy = data.aws_iam_policy_document.ecs_task_permissions.json
}
