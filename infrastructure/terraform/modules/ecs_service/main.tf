resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${var.name_prefix}/${var.name}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "this" {
  family                   = "${var.name_prefix}-${var.name}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.cpu)
  memory                   = tostring(var.memory)
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn

  container_definitions = jsonencode([
    {
      name      = var.name
      image     = var.image
      essential = true
      portMappings = [
        {
          name          = var.name
          containerPort = var.port
          protocol      = "tcp"
        }
      ]
      environment = [
        for k, v in merge({ HOST = "0.0.0.0", PORT = tostring(var.port) }, var.extra_env) :
        { name = k, value = v }
      ]
      healthCheck = {
        command     = var.health_check_command
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 20
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.this.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = var.name
        }
      }
    }
  ])
}

resource "aws_ecs_service" "this" {
  name                 = "${var.name_prefix}-${var.name}"
  cluster              = var.cluster_id
  task_definition      = aws_ecs_task_definition.this.arn
  desired_count        = var.min_count
  launch_type          = "FARGATE"
  force_new_deployment = true # handy for CI-triggered redeploys

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = var.security_group_ids
    assign_public_ip = true
  }

  service_connect_configuration {
    enabled   = true
    namespace = var.namespace_arn

    service {
      port_name      = var.name
      discovery_name = var.service_connect_alias

      client_alias {
        port     = var.port
        dns_name = var.service_connect_alias
      }
    }
  }

  dynamic "load_balancer" {
    for_each = var.attach_to_alb ? [1] : []
    content {
      target_group_arn = var.alb_target_group_arn
      container_name   = var.name
      container_port   = var.port
    }
  }

  # A start-stop toggle (scripts/start-env.sh / stop-env.sh) manages desired
  # count after creation — Terraform shouldn't fight it on every apply.
  lifecycle {
    ignore_changes = [desired_count]
  }
}

resource "aws_appautoscaling_target" "this" {
  max_capacity       = var.max_count
  min_capacity       = var.min_count
  resource_id        = "service/${var.cluster_name}/${aws_ecs_service.this.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "cpu" {
  count              = var.scaling_metric == "cpu" ? 1 : 0
  name               = "${var.name_prefix}-${var.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.this.resource_id
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  service_namespace  = aws_appautoscaling_target.this.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = var.scaling_target
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

resource "aws_appautoscaling_policy" "alb_request_count" {
  count              = var.scaling_metric == "alb_request_count" ? 1 : 0
  name               = "${var.name_prefix}-${var.name}-alb-req"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.this.resource_id
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  service_namespace  = aws_appautoscaling_target.this.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = var.alb_resource_label
    }
    target_value       = var.scaling_target
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}
