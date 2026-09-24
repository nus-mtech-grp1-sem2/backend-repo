module "services" {
  source = "./modules/ecs_service"

  for_each = var.create_services ? local.services : {}

  name                  = each.key
  name_prefix           = local.name_prefix
  image                 = each.value.image
  port                  = each.value.port
  cpu                   = each.value.cpu
  memory                = each.value.memory
  min_count             = each.value.min_count
  max_count             = each.value.max_count
  extra_env             = each.value.extra_env
  secret_env            = each.value.secret_env
  service_connect_alias = each.value.service_connect_alias
  attach_to_alb         = each.value.attach_to_alb
  health_check_command  = each.value.health_check_command
  scaling_metric        = each.value.scaling_metric
  scaling_target        = each.value.scaling_target

  region             = var.region
  cluster_id         = aws_ecs_cluster.main.id
  cluster_name       = aws_ecs_cluster.main.name
  namespace_arn      = aws_service_discovery_http_namespace.main.arn
  execution_role_arn = aws_iam_role.ecs_task_execution.arn
  task_role_arn = each.key == "queue" ? aws_iam_role.queue_task.arn : (
    each.key == "order" ? aws_iam_role.order_task.arn : (
      each.key == "ticket" ? aws_iam_role.ticket_task.arn : aws_iam_role.ecs_task.arn
    )
  )
  subnet_ids         = aws_subnet.public[*].id
  security_group_ids = [aws_security_group.ecs_tasks.id]

  alb_target_group_arn = each.value.attach_to_alb ? aws_lb_target_group.kong.arn : null
  alb_listener_arn     = each.value.attach_to_alb ? aws_lb_listener.http.arn : null
  alb_resource_label   = each.value.attach_to_alb ? "${aws_lb.main.arn_suffix}/${aws_lb_target_group.kong.arn_suffix}" : null
}
