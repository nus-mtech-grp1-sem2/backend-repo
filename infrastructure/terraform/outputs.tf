output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.frontend.domain_name
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.frontend.id
}

output "frontend_bucket_name" {
  value = aws_s3_bucket.frontend.bucket
}

output "ecr_backend_repository_url" {
  value = aws_ecr_repository.backend.repository_url
}

output "ecr_kong_repository_url" {
  value = aws_ecr_repository.kong.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "customer_admitted_queue_url" {
  value = aws_sqs_queue.customer_admitted.url
}

output "github_deploy_backend_role_arn" {
  value = aws_iam_role.github_deploy_backend.arn
}

output "github_deploy_frontend_role_arn" {
  value = aws_iam_role.github_deploy_frontend.arn
}
