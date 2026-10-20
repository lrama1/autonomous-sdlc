resource "aws_ecs_cluster" "main" {
  name = var.name
}

resource "aws_cloudwatch_log_group" "platform" {
  name              = "/${var.name}"
  retention_in_days = 7
}

resource "aws_service_discovery_private_dns_namespace" "main" {
  name = "${var.name}.local"
  vpc  = aws_vpc.main.id
}

resource "aws_service_discovery_service" "gateway" {
  name = "gateway"
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.main.id
    dns_records {
      ttl  = 10
      type = "A"
    }
  }
  health_check_custom_config { failure_threshold = 1 }
}

# ---- roles
data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# The agent starting a task may read exactly the secrets that are injected into it.
resource "aws_iam_role_policy" "execution_secrets" {
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [for s in aws_secretsmanager_secret.config : s.arn]
    }]
  })
}

# The API's own role: only its runtime secrets (GitHub App keys, written when an admin registers the Apps).
resource "aws_iam_role" "api" {
  name               = "${var.name}-api"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "api_runtime_secrets" {
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "secretsmanager:GetSecretValue",
        "secretsmanager:PutSecretValue",
        "secretsmanager:CreateSecret",
        "secretsmanager:DescribeSecret",
      ]
      Resource = "arn:aws:secretsmanager:${var.region}:${local.account}:secret:${local.runtime_prefix}*"
    }]
  })
}

resource "aws_iam_role" "gateway" {
  name               = "${var.name}-gateway"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

# ---- task definitions
locals {
  secret_arn = { for k, s in aws_secretsmanager_secret.config : k => s.arn }
  log = {
    logDriver = "awslogs"
    options = {
      "awslogs-group"  = aws_cloudwatch_log_group.platform.name
      "awslogs-region" = var.region
    }
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.api.arn
  container_definitions = jsonencode([{
    name         = "api"
    image        = local.image
    essential    = true
    portMappings = [{ containerPort = 8080 }]
    environment = [
      { name = "SDLC_ENV", value = "aws-sandbox" },
      { name = "PUBLIC_URL", value = local.public_url },
      { name = "OIDC_ISSUER", value = local.issuer },
      { name = "OIDC_CLIENT_ID", value = aws_cognito_user_pool_client.web.id },
      { name = "BOOTSTRAP_ADMIN_EMAIL", value = var.bootstrap_admin_email },
      { name = "DATABASE_CA_FILE", value = "/etc/ssl/rds-global-bundle.pem" },
      { name = "SECRETS_BACKEND", value = "aws" },
      { name = "SECRETS_PREFIX", value = local.runtime_prefix },
      { name = "GATEWAY_URL", value = "http://gateway.${aws_service_discovery_private_dns_namespace.main.name}:8787" },
      { name = "INDEPENDENT_REVIEW", value = tostring(var.independent_review) },
      { name = "SECURITY_REVIEW", value = var.security_review },
      { name = "PREVIEW_ORIGIN", value = local.preview_origin },
      { name = "FARGATE_PREVIEW_TASK_DEFINITION", value = aws_ecs_task_definition.preview.family },
      { name = "FARGATE_PREVIEW_SECURITY_GROUPS", value = aws_security_group.preview.id },
      { name = "AGENT_ENGINE", value = var.agent_engine },
      { name = "RUNNER_ADAPTER", value = "fargate" },
      { name = "RUNNER_EGRESS_ALLOW", value = var.runner_egress_allow },
      { name = "FARGATE_CLUSTER", value = aws_ecs_cluster.main.name },
      { name = "FARGATE_TASK_DEFINITION", value = aws_ecs_task_definition.runner.family },
      { name = "FARGATE_SUBNETS", value = aws_subnet.runner.id },
      { name = "FARGATE_SECURITY_GROUPS", value = aws_security_group.runner.id },
      { name = "FARGATE_STATE_BUCKET", value = aws_s3_bucket.state.bucket },
      { name = "MAX_CONCURRENT_RUNS", value = "6" },
      { name = "AWS_REGION", value = var.region },
    ]
    secrets = [
      { name = "DATABASE_URL", valueFrom = local.secret_arn["database_url"] },
      { name = "SESSION_SECRET", valueFrom = local.secret_arn["session_secret"] },
      { name = "OIDC_CLIENT_SECRET", valueFrom = local.secret_arn["oidc_client_secret"] },
      { name = "EGRESS_ALLOW_TOKEN", valueFrom = local.secret_arn["egress_token"] },
    ]
    logConfiguration = merge(local.log, { options = merge(local.log.options, { "awslogs-stream-prefix" = "api" }) })
  }])
}

resource "aws_ecs_task_definition" "gateway" {
  family                   = "${var.name}-gateway"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.gateway.arn
  container_definitions = jsonencode([{
    name         = "gateway"
    image        = local.image
    essential    = true
    command      = ["node", "--import", "tsx", "apps/gateway/src/main.ts"]
    portMappings = [{ containerPort = 8787 }]
    environment = [
      { name = "GATEWAY_HOST", value = "0.0.0.0" },
      { name = "DATABASE_CA_FILE", value = "/etc/ssl/rds-global-bundle.pem" },
    ]
    secrets = [
      { name = "DATABASE_URL", valueFrom = local.secret_arn["database_url"] },
      { name = "OPENROUTER_KEY_AGENTS", valueFrom = local.secret_arn["openrouter_key_agents"] },
    ]
    logConfiguration = merge(local.log, { options = merge(local.log.options, { "awslogs-stream-prefix" = "gateway" }) })
  }])
}

resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 8080
  }
  service_registries { registry_arn = aws_service_discovery_service.api.arn }
  health_check_grace_period_seconds = 90
  depends_on                        = [aws_lb_listener_rule.from_edge]
}

resource "aws_ecs_service" "gateway" {
  name            = "gateway"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.gateway.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = true
  }
  service_registries {
    registry_arn = aws_service_discovery_service.gateway.arn
  }
}

# ---- an account-level alarm for cost, because this stack can be left running by accident
resource "aws_budgets_budget" "month" {
  count        = var.monthly_budget_usd > 0 && var.budget_email != "" ? 1 : 0
  name         = "${var.name}-month"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_email]
  }
}
