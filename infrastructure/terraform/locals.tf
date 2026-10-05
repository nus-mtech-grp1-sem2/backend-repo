locals {
  name_prefix = "onestage"

  # Schema each service owns in the shared MySQL instance — mirrors
  # docker-compose.yml's per-service DB_NAME and the one-instance/five-schemas
  # split documented in database/onestage-system-design.md. `inventory`
  # shares `event_inventory` with `event` because both read/write the same
  # tables (events, inventory_items, seats, holds). `notification` owns the
  # `notification` schema (email_notifications, one row per ticket email) and
  # crashes on start without these settings. `auth` is left out of this map:
  # it is Cognito-only and doesn't talk to MySQL.
  service_db_name = {
    event        = "event_inventory"
    inventory    = "event_inventory"
    queue        = "queue"
    order        = "checkout"
    ticket       = "ticketing"
    notification = "notification"
  }

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
        # Kong's peer is always an ALB node, so without these the per-IP
        # rate limit in kong.yml would key every client to 2-3 ALB IPs.
        # CloudFront appends the viewer IP to X-Forwarded-For and the ALB
        # appends the edge IP; reading the header right to left and skipping
        # trusted hops (ALB inside the VPC, CloudFront's origin-facing
        # ranges) lands on the viewer, and anything a client forged further
        # left is never reached.
        extra_env = {
          KONG_REAL_IP_HEADER    = "X-Forwarded-For"
          KONG_REAL_IP_RECURSIVE = "on"
          KONG_TRUSTED_IPS = join(",", concat(
            [var.vpc_cidr],
            [for entry in data.aws_ec2_managed_prefix_list.cloudfront.entries : entry.cidr],
          ))
        }
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
          # Secrets Manager material. Every service gets these, not just
          # `auth`: `event` independently verifies bearer tokens for its
          # own protected routes (see services/event/src/index.ts) and
          # needs them to build its CognitoJwtVerifier.
          {
            COGNITO_USER_POOL_ID = "ap-southeast-1_cgmx4fpO2"
            COGNITO_CLIENT_ID    = "gh94lqsterju3qoffje1grep8"
          },
          contains(keys(local.service_db_name), name) ? {
            DB_HOST = "mysql"
            DB_NAME = local.service_db_name[name]
            DB_PORT = "3306"
            DB_SSL  = "false"
          } : {},
          contains(["order", "ticket"], name) ? {
            ORDER_EVENTS_QUEUE_URL = aws_sqs_queue.order_events.url
          } : {},
          # Ticket issuance asks the notification service to email each ticket's
          # QR code (Service Connect alias `notification`).
          name == "ticket" ? {
            NOTIFICATION_SERVICE_URL = "http://notification:${var.node_services["notification"]}"
          } : {},
          name == "order" ? {
            PAYMENT_REQUESTS_QUEUE_URL = aws_sqs_queue.payment_requests.url
            QUEUE_SERVICE_URL          = "http://queue:3003"
            QUEUE_REFILL_TIMEOUT_MS    = "1000"
          } : {},
          name == "queue" ? {
            CUSTOMER_ADMITTED_QUEUE_URL = aws_sqs_queue.customer_admitted.url
          } : {}
        )
        secret_env = merge(
          contains(keys(local.service_db_name), name) ? {
            DB_USER     = "${aws_secretsmanager_secret.mysql.arn}:MYSQL_USER::"
            DB_PASSWORD = "${aws_secretsmanager_secret.mysql.arn}:MYSQL_PASSWORD::"
          } : {},
          contains(["order", "queue", "ticket", "notification"], name) ? {
            INTERNAL_API_TOKEN = "${aws_secretsmanager_secret.mysql.arn}:INTERNAL_API_TOKEN::"
          } : {},
          name == "ticket" ? {
            SCANNER_SESSION_SECRET = "${aws_secretsmanager_secret.mysql.arn}:SCANNER_SESSION_SECRET::"
          } : {},
          # Gmail sender for booking confirmation emails. These two keys are
          # added to the secret by hand in the console (see secrets.tf) — the
          # values never pass through Terraform or its state.
          name == "notification" ? {
            SMTP_USER         = "${aws_secretsmanager_secret.mysql.arn}:SMTP_USER::"
            SMTP_APP_PASSWORD = "${aws_secretsmanager_secret.mysql.arn}:SMTP_APP_PASSWORD::"
          } : {}
        )
      }
    }
  )
}
