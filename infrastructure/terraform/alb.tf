resource "aws_lb" "main" {
  name               = "${local.name_prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  # Course MVP: no deletion protection so `terraform destroy` at the end of
  # the project isn't blocked. Everything stateful (EFS, S3, Secrets, ECR)
  # still has prevent_destroy set separately.
  enable_deletion_protection = false
}

# Kong is the sole ingress — the 7 Node services are internal-only via
# Service Connect, never behind the ALB directly.
resource "aws_lb_target_group" "kong" {
  name        = "${local.name_prefix}-kong-tg"
  port        = 8000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip" # awsvpc network mode

  health_check {
    path                = "/status"
    port                = "8100"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  # Low so scale-in is visible within a short demo window, not a production
  # value (production would typically use 60-300s to drain in-flight requests).
  deregistration_delay = 30
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.kong.arn
  }
}
