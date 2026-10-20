output "url" {
  value       = local.public_url
  description = "Open this in a browser."
}

output "ecr_repository" {
  value = aws_ecr_repository.platform.repository_url
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "cognito_domain" {
  value = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.region}.amazoncognito.com"
}

output "previews_url" {
  value       = local.preview_origin
  description = "The address previews are served from. It is not the platform's."
}

output "runner_ecr_repository" {
  value = aws_ecr_repository.runner.repository_url
}

output "cluster" {
  value = aws_ecs_cluster.main.name
}

output "runtime_secret_prefix" {
  value = local.runtime_prefix
}
