data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

# ALB only accepts traffic that has come through CloudFront — not the open
# internet directly. Free (security groups have no per-rule cost), unlike
# WAF/Network Firewall which we're deliberately not using.
# Rules declared as standalone aws_vpc_security_group_*_rule resources below,
# not inline — mixing inline blocks with standalone rule resources on the
# same SG is an AWS-provider anti-pattern that produces incorrect/missing
# diffs (confirmed while building this: an inline egress removal silently
# stopped showing up in `plan` once a standalone egress rule referencing this
# SG existed). Keeping this SG 100% standalone-rule-managed avoids that.
resource "aws_security_group" "alb" {
  name        = "${local.name_prefix}-alb"
  description = "Allow HTTP from CloudFront only"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.name_prefix}-alb-sg" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_from_cloudfront" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from CloudFront edge"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront.id
}

# Looked up by name rather than referenced as aws_security_group.ecs_tasks.id
# on purpose: that SG carries 12+ MySQL ingress rules added by hand outside
# Terraform (see docs/findings/2026-09-16-mysql-network-exposure-and-scaling-cost.md).
# A direct resource attribute reference would pull aws_security_group.ecs_tasks
# into this apply's dependency graph and silently delete those undeclared
# rules as a side effect. A data source lookup has no such effect — it's a
# read-only query, not a managed dependency.
data "aws_security_group" "ecs_tasks_lookup" {
  # Built from the same local used to name aws_security_group.ecs_tasks, not
  # a reference to that resource's .name attribute — an attribute reference
  # would create the dependency edge this data source exists to avoid.
  filter {
    name   = "group-name"
    values = ["${local.name_prefix}-ecs-tasks"]
  }
}

resource "aws_vpc_security_group_egress_rule" "alb_to_kong_proxy" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Kong proxy on ECS tasks"
  from_port                    = 8000
  to_port                      = 8000
  ip_protocol                  = "tcp"
  referenced_security_group_id = data.aws_security_group.ecs_tasks_lookup.id
}

resource "aws_vpc_security_group_egress_rule" "alb_to_kong_health" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Kong health check on ECS tasks"
  from_port                    = 8100
  to_port                      = 8100
  ip_protocol                  = "tcp"
  referenced_security_group_id = data.aws_security_group.ecs_tasks_lookup.id
}

# One SG for every ECS task (Kong, the 7 Node services, MySQL). Ingress from
# the ALB (Kong's proxy + status ports) and from itself (Service Connect
# inter-task traffic + MySQL access from the Node services).
# Look up the existing EFS group to avoid a dependency cycle: its inline
# ingress references ecs_tasks. This root already targets an existing stack.
data "aws_security_group" "efs_lookup" {
  vpc_id = aws_vpc.main.id
  filter {
    name   = "group-name"
    values = ["${local.name_prefix}-efs"]
  }
}

resource "aws_security_group" "ecs_tasks" {
  name        = "${local.name_prefix}-ecs-tasks"
  description = "ECS tasks: ingress from ALB (Kong) and from each other (Service Connect)"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Kong proxy from ALB"
    from_port       = 8000
    to_port         = 8000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  ingress {
    description     = "Kong status from ALB (health check)"
    from_port       = 8100
    to_port         = 8100
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  ingress {
    description = "Service Connect / inter-task traffic (Node services + MySQL)"
    from_port   = 0
    to_port     = 65535
    protocol    = "tcp"
    self        = true
  }

  # Keep the complete outbound rule set inline. Do not replace a connectivity
  # rule with an email rule in the console or mix standalone egress resources
  # with these blocks: Terraform reconciles the entire inline rule set.
  egress {
    description = "Inter microservice connectivity"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    self        = true
  }

  egress {
    description = "Secrets Manager, ECR, CloudWatch Logs"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description     = "EFS volume mount"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [data.aws_security_group.efs_lookup.id]
  }

  egress {
    description = "SMTPS to Gmail for notification emails"
    from_port   = 465
    to_port     = 465
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name_prefix}-ecs-tasks-sg" }
}

resource "aws_security_group" "efs" {
  name        = "${local.name_prefix}-efs"
  description = "Allow NFS from ECS tasks only"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "NFS from ECS tasks"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  # No egress — an NFS server only ever responds to inbound connections, it
  # never initiates outbound traffic, so deny-all egress is correct here.

  tags = { Name = "${local.name_prefix}-efs-sg" }
}
