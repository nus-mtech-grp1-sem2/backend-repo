# Stateful — fixed at desired_count 1, never autoscaled, deliberately kept
# out of module.services' for_each.

resource "aws_cloudwatch_log_group" "mysql" {
  count             = var.create_services ? 1 : 0
  name              = "/ecs/${local.name_prefix}/mysql"
  retention_in_days = 7
}

resource "aws_ecs_task_definition" "mysql" {
  count                    = var.create_services ? 1 : 0
  family                   = "${local.name_prefix}-mysql"
  requires_compatibilities = ["EC2"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  volume {
    name = "mysql-data"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.mysql.id
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.mysql.id
        iam             = "ENABLED"
      }
    }
  }

  container_definitions = jsonencode([
    {
      name      = "mysql"
      image     = "mysql:8.0"
      essential = true
      portMappings = [
        { name = "mysql", containerPort = 3306, protocol = "tcp" }
      ]
      mountPoints = [
        { sourceVolume = "mysql-data", containerPath = "/var/lib/mysql" }
      ]
      secrets = [
        { name = "MYSQL_ROOT_PASSWORD", valueFrom = "${aws_secretsmanager_secret.mysql.arn}:MYSQL_ROOT_PASSWORD::" },
        { name = "MYSQL_DATABASE", valueFrom = "${aws_secretsmanager_secret.mysql.arn}:MYSQL_DATABASE::" },
        { name = "MYSQL_USER", valueFrom = "${aws_secretsmanager_secret.mysql.arn}:MYSQL_USER::" },
        { name = "MYSQL_PASSWORD", valueFrom = "${aws_secretsmanager_secret.mysql.arn}:MYSQL_PASSWORD::" },
      ]
      healthCheck = {
        command     = ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -uroot -p$MYSQL_ROOT_PASSWORD || exit 1"]
        interval    = 15
        timeout     = 5
        retries     = 5
        startPeriod = 60
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.mysql[0].name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "mysql"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "mysql" {
  count           = var.create_services ? 1 : 0
  name            = "${local.name_prefix}-mysql"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.mysql[0].arn
  desired_count   = 1

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = true
  }

  service_connect_configuration {
    enabled   = true
    namespace = aws_service_discovery_http_namespace.main.arn

    service {
      port_name      = "mysql"
      discovery_name = "mysql"

      client_alias {
        port     = 3306
        dns_name = "mysql"
      }
    }
  }

  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_ecs_cluster_capacity_providers.main]
}
