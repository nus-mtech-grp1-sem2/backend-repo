resource "aws_ecs_cluster" "main" {
  name = "${local.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "disabled" # cost: skip enhanced observability metrics for an MVP demo
  }
}

resource "aws_service_discovery_http_namespace" "main" {
  name        = "${local.name_prefix}.local"
  description = "Service Connect namespace for internal service-to-service calls"
}
