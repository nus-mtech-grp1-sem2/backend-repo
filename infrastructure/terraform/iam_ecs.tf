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

# Instance role/profile for the ASG-backed capacity provider's EC2 hosts.
data "aws_iam_policy_document" "ec2_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_instance" {
  name               = "${local.name_prefix}-ecs-instance"
  assume_role_policy = data.aws_iam_policy_document.ec2_trust.json
}

resource "aws_iam_role_policy_attachment" "ecs_instance" {
  role       = aws_iam_role.ecs_instance.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

# SSM Session Manager instead of SSH key pairs — no launch-template key path.
resource "aws_iam_role_policy_attachment" "ecs_instance_ssm" {
  role       = aws_iam_role.ecs_instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ecs_instance" {
  name = "${local.name_prefix}-ecs-instance"
  role = aws_iam_role.ecs_instance.name
}
