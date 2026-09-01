locals {
  name_prefix = "onestage"

  # Every service the module.ecs_service for_each drives: Kong (the only
  # ALB-attached, internet-facing one) plus the 7 Node services. CPU/memory
  # are deliberately minimal Fargate-valid sizes (256 CPU/512MiB is the
  # smallest Fargate allows) — cheap per-task, and small enough that a
  # modest k6 load pushes service-level autoscaling to add task count
  # quickly, making horizontal scale-out easy to trigger during a demo.
  services = merge(
    {
      kong = {
        image                 = "${aws_ecr_repository.kong.repository_url}:latest"
        port                  = 8000
        cpu                   = 256
        memory                = 512
        min_count             = 1
        max_count             = 4
        service_connect_alias = "kong"
        attach_to_alb         = true
        extra_env             = {}
        # The kong:3.9 image is minimal Ubuntu with no wget/curl — `kong
        # health` is Kong's own built-in CLI healthcheck (checks the nginx
        # workers directly, no HTTP call needed). wget here always failed
        # with "not found", so Kong's container was continuously judged
        # unhealthy and cycled by ECS roughly every minute — never caught
        # earlier because tasks never previously ran long enough to reach
        # a real healthcheck.
        health_check_command = ["CMD", "kong", "health"]
        # ALB requests-per-target, per the ecs-capacity-review skill's
        # preferred signal for synchronous HTTP demand. Starting guess,
        # tune after a real k6 run.
        scaling_metric = "alb_request_count"
        scaling_target = 75
        secret_env     = {}
      }
    },
    {
      for name, port in var.node_services : name => {
        image                 = "${aws_ecr_repository.backend.repository_url}:latest"
        port                  = port
        cpu                   = 256
        memory                = 512
        min_count             = 1
        max_count             = 3
        service_connect_alias = name
        attach_to_alb         = false
        health_check_command  = ["CMD-SHELL", "wget -qO- http://localhost:${port}/health || exit 1"]
        # CPU as an interim primary signal (guardrail-not-primary per the
        # governance skill; a request-count-based Service Connect metric
        # would be preferable, pending verification it's available).
        scaling_metric = "cpu"
        scaling_target = 60
        extra_env = merge(
          { SERVICE = name },
          # Non-secret identifiers (already hardcoded in core-frontend's
          # app.config.ts and shipped in the public JS bundle) — not
          # Secrets Manager material.
          name == "auth" ? {
            COGNITO_USER_POOL_ID = "ap-southeast-1_cgmx4fpO2"
            COGNITO_CLIENT_ID    = "gh94lqsterju3qoffje1grep8"
            DB_HOST              = "mysql.onestage.internal"
            DB_NAME              = "onestage"
            DB_PORT              = "3306"
            DB_SSL               = "false"
          } : {}
        )
        secret_env = name == "auth" ? {
          DB_USER     = "${aws_secretsmanager_secret.mysql.arn}:MYSQL_USER::"
          DB_PASSWORD = "${aws_secretsmanager_secret.mysql.arn}:MYSQL_PASSWORD::"
        } : {}
      }
    }
  )
}
