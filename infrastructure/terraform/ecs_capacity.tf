# Classic ASG-backed capacity provider, NOT ECS Managed Instances.
# Managed Instances was the original choice, but the hashicorp/aws provider
# has open, unresolved bugs managing it via Terraform as of this writing
# (github.com/hashicorp/terraform-provider-aws issues #44783, #45693 — a
# hard API rejection when combined with an ASG-style capacity provider, and
# an unrelated ACTIVE-state race even standalone). This gets the same
# outcome the governance skill asks for — ECS-on-EC2, On-Demand only,
# capacity-provider-driven instance scaling with no competing ASG scaling
# policy — on a resource type with mature Terraform support.

data "aws_ssm_parameter" "ecs_ami" {
  name = "/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended"
}

locals {
  ecs_ami_id = jsondecode(data.aws_ssm_parameter.ecs_ami.value)["image_id"]
}

resource "aws_launch_template" "ecs" {
  name_prefix   = "${local.name_prefix}-ecs-"
  image_id      = local.ecs_ami_id
  instance_type = var.instance_types[0]

  iam_instance_profile {
    arn = aws_iam_instance_profile.ecs_instance.arn
  }

  vpc_security_group_ids = [aws_security_group.ecs_tasks.id]

  user_data = base64encode(<<-EOF
    #!/bin/bash
    echo ECS_CLUSTER=${aws_ecs_cluster.main.name} >> /etc/ecs/ecs.config
    echo ECS_WARM_POOLS_CHECK=true >> /etc/ecs/ecs.config
  EOF
  )

  metadata_options {
    http_tokens = "required" # IMDSv2 only
  }

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${local.name_prefix}-ecs-instance" }
  }
}

resource "aws_autoscaling_group" "ecs" {
  name                  = "${local.name_prefix}-ecs-asg"
  vpc_zone_identifier   = aws_subnet.public[*].id
  min_size              = var.asg_min_size
  max_size              = var.asg_max_size
  desired_capacity      = var.asg_min_size
  protect_from_scale_in = true # required for ECS managed_termination_protection

  mixed_instances_policy {
    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.ecs.id
        version            = "$Latest"
      }

      dynamic "override" {
        for_each = var.instance_types
        content {
          instance_type = override.value
        }
      }
    }

    instances_distribution {
      on_demand_percentage_above_base_capacity = 100 # On-Demand only, per governance skill
    }
  }

  tag {
    key                 = "AmazonECSManaged"
    value               = true
    propagate_at_launch = true
  }

  lifecycle {
    ignore_changes = [desired_capacity] # ECS capacity provider / start-stop scripts own this after creation
  }
}
