# Everything an agent run needs on AWS, so that nothing has to run on a developer's machine (spec 12.4, spike 6).
#
# A run is one Fargate task in an isolated subnet: no route to the internet, no task role, no AWS credentials. It reaches
# exactly three things: the platform API and the model gateway (by private names), the egress proxy (the only way out,
# to an allowlist the platform controls), and S3 through presigned URLs for its own parked state. Images and logs come
# through VPC endpoints.

variable "runner_cpu" {
  type    = number
  default = 2048
}

variable "runner_memory" {
  type    = number
  default = 4096
}

variable "preview_cpu" {
  type    = number
  default = 1024
}

variable "preview_memory" {
  type    = number
  default = 2048
}

variable "runner_egress_allow" {
  type        = string
  default     = "github.com,registry.npmjs.org"
  description = "Hosts a run may open HTTPS tunnels to before the API has told the proxy otherwise. The platform replaces this list at run time from its Integration Register."
}

variable "extra_dns_allow" {
  type        = list(string)
  default     = []
  description = "Domains, beyond the platform's own, that the VPC resolver may answer. The platform's tasks share the resolver, so a documentation host the API fetches must be listed here."
}

locals {
  ns           = aws_service_discovery_private_dns_namespace.main.name
  runner_image = "${aws_ecr_repository.runner.repository_url}:${var.image_tag}"
  proxy_url    = "http://egress.${local.ns}:3128"
  api_private  = "http://api.${local.ns}:8080"
  # The VPC resolver answers only these. The platform's own tasks use it too, so it holds what they call.
  dns_allow = distinct(concat(
    [local.ns, "*.${local.ns}"],
    ["amazonaws.com", "*.amazonaws.com", "amazoncognito.com", "*.amazoncognito.com"],
    ["github.com", "*.github.com", "openrouter.ai", "*.openrouter.ai", "slack.com", "*.slack.com"],
    flatten([for d in var.extra_dns_allow : [d, "*.${d}"]]),
  ))
}

# ---- images and state
resource "aws_ecr_repository" "runner" {
  name         = "${var.name}-runner"
  force_delete = true
}

resource "aws_ecr_lifecycle_policy" "runner" {
  repository = aws_ecr_repository.runner.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 5 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
}

# A parked run's files, between one task and the next. Reached only through presigned URLs.
resource "aws_s3_bucket" "state" {
  bucket        = "${var.name}-runner-state-${local.account}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration { days = 14 }
    abort_incomplete_multipart_upload { days_after_initiation = 2 }
  }
}

# ---- the isolated subnet: no route out at all
resource "aws_subnet" "runner" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.60.20.0/24"
  availability_zone = local.azs[0]
  tags              = { Name = "${var.name}-runner" }
}

resource "aws_route_table" "runner" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.name}-runner" }
}

resource "aws_route_table_association" "runner" {
  subnet_id      = aws_subnet.runner.id
  route_table_id = aws_route_table.runner.id
}

resource "aws_security_group" "runner" {
  name        = "${var.name}-runner"
  description = "Agent runs"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "egress_proxy" {
  name        = "${var.name}-egress"
  description = "The allowlist proxy"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "endpoints" {
  name        = "${var.name}-endpoints"
  description = "VPC endpoints for images and logs"
  vpc_id      = aws_vpc.main.id
}

# What a run may reach: the proxy, the API and the gateway, the endpoints, and S3.
resource "aws_vpc_security_group_egress_rule" "runner_to_proxy" {
  security_group_id            = aws_security_group.runner.id
  referenced_security_group_id = aws_security_group.egress_proxy.id
  ip_protocol                  = "tcp"
  from_port                    = 3128
  to_port                      = 3128
}

resource "aws_vpc_security_group_egress_rule" "runner_to_api" {
  security_group_id            = aws_security_group.runner.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
}

resource "aws_vpc_security_group_egress_rule" "runner_to_gateway" {
  security_group_id            = aws_security_group.runner.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 8787
  to_port                      = 8787
}

resource "aws_vpc_security_group_egress_rule" "runner_to_endpoints" {
  security_group_id            = aws_security_group.runner.id
  referenced_security_group_id = aws_security_group.endpoints.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_egress_rule" "runner_to_s3" {
  security_group_id = aws_security_group.runner.id
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

# A preview runs unreviewed code, so it gets a group of its own: it reaches the proxy, the endpoints and S3, but not the
# API or the gateway the way a run does. The platform reaches the port it opens, and nothing else does.
resource "aws_security_group" "preview" {
  name        = "${var.name}-preview"
  description = "Previews of pull requests"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "preview_from_platform" {
  security_group_id            = aws_security_group.preview.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 1024
  to_port                      = 65535
}

resource "aws_vpc_security_group_egress_rule" "preview_to_proxy" {
  security_group_id            = aws_security_group.preview.id
  referenced_security_group_id = aws_security_group.egress_proxy.id
  ip_protocol                  = "tcp"
  from_port                    = 3128
  to_port                      = 3128
}

resource "aws_vpc_security_group_egress_rule" "preview_to_endpoints" {
  security_group_id            = aws_security_group.preview.id
  referenced_security_group_id = aws_security_group.endpoints.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_egress_rule" "preview_to_s3" {
  security_group_id = aws_security_group.preview.id
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "proxy_from_preview" {
  security_group_id            = aws_security_group.egress_proxy.id
  referenced_security_group_id = aws_security_group.preview.id
  ip_protocol                  = "tcp"
  from_port                    = 3128
  to_port                      = 3128
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_runner_api" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.runner.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_runner_gateway" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.runner.id
  ip_protocol                  = "tcp"
  from_port                    = 8787
  to_port                      = 8787
}

# The proxy asks the API for its allowlist.
resource "aws_vpc_security_group_ingress_rule" "tasks_from_proxy" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.egress_proxy.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
}

resource "aws_vpc_security_group_ingress_rule" "proxy_from_runner" {
  security_group_id            = aws_security_group.egress_proxy.id
  referenced_security_group_id = aws_security_group.runner.id
  ip_protocol                  = "tcp"
  from_port                    = 3128
  to_port                      = 3128
}

resource "aws_vpc_security_group_egress_rule" "proxy_out" {
  security_group_id = aws_security_group.egress_proxy.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# The endpoints' private DNS names apply to the whole VPC, so the platform's own tasks reach ECR and CloudWatch Logs
# through them too. They must be allowed in, or those tasks lose their logs (found in spike 6).
resource "aws_vpc_security_group_ingress_rule" "endpoints_from_vpc" {
  security_group_id = aws_security_group.endpoints.id
  cidr_ipv4         = aws_vpc.main.cidr_block
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

# ---- VPC endpoints for the isolated subnet
resource "aws_vpc_endpoint" "interface" {
  for_each            = toset(["ecr.api", "ecr.dkr", "logs"])
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.runner.id]
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.runner.id]
  # The ECR layer bucket (image pulls) and the one state bucket. Any other bucket is refused, so S3 is no way out.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Principal = "*", Action = ["s3:GetObject"], Resource = ["arn:aws:s3:::prod-${var.region}-starport-layer-bucket/*"] },
      { Effect = "Allow", Principal = "*", Action = ["s3:GetObject", "s3:PutObject"], Resource = ["${aws_s3_bucket.state.arn}/*"] },
      # Without this S3 answers 403, not 404, for an object that is not there (found on the first run on AWS).
      { Effect = "Allow", Principal = "*", Action = ["s3:ListBucket"], Resource = [aws_s3_bucket.state.arn] },
    ]
  })
}

# ---- DNS: the VPC resolver answers the private names, AWS, and what the platform calls. Nothing else.
resource "aws_route53_resolver_firewall_domain_list" "allow" {
  name    = "${var.name}-allow"
  domains = local.dns_allow
}

resource "aws_route53_resolver_firewall_domain_list" "all" {
  name    = "${var.name}-all"
  domains = ["*"]
}

resource "aws_route53_resolver_firewall_rule_group" "main" {
  name = "${var.name}-dns"
}

resource "aws_route53_resolver_firewall_rule" "allow" {
  name                    = "allow-list"
  firewall_rule_group_id  = aws_route53_resolver_firewall_rule_group.main.id
  firewall_domain_list_id = aws_route53_resolver_firewall_domain_list.allow.id
  priority                = 100
  action                  = "ALLOW"
}

resource "aws_route53_resolver_firewall_rule" "block" {
  name                    = "block-rest"
  firewall_rule_group_id  = aws_route53_resolver_firewall_rule_group.main.id
  firewall_domain_list_id = aws_route53_resolver_firewall_domain_list.all.id
  priority                = 200
  action                  = "BLOCK"
  block_response          = "NXDOMAIN"
}

resource "aws_route53_resolver_firewall_rule_group_association" "main" {
  name                   = "${var.name}-dns"
  firewall_rule_group_id = aws_route53_resolver_firewall_rule_group.main.id
  vpc_id                 = aws_vpc.main.id
  priority               = 101
}

# ---- private names the runs use
resource "aws_service_discovery_service" "api" {
  name = "api"
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.main.id
    dns_records {
      ttl  = 10
      type = "A"
    }
  }
  health_check_custom_config { failure_threshold = 1 }
}

resource "aws_service_discovery_service" "egress" {
  name = "egress"
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.main.id
    dns_records {
      ttl  = 10
      type = "A"
    }
  }
  health_check_custom_config { failure_threshold = 1 }
}

# ---- the egress proxy: the same program the Docker runner uses, as a service
resource "random_password" "egress" {
  length  = 40
  special = false
}

resource "aws_ecs_task_definition" "egress" {
  family                   = "${var.name}-egress"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  container_definitions = jsonencode([{
    name      = "egress"
    image     = local.runner_image
    essential = true
    command   = ["node", "/app/egress.mjs"]
    environment = [
      { name = "EGRESS_PROXY_PORT", value = "3128" },
      { name = "EGRESS_FORWARDS", value = "" },
      # Used until the API answers, and if it stops answering.
      { name = "EGRESS_ALLOW", value = var.runner_egress_allow },
      { name = "EGRESS_ALLOW_URL", value = "${local.api_private}/api/internal/egress-allow" },
      # Names are resolved here, not by the VPC resolver, which only answers the allowlist above.
      { name = "EGRESS_DNS", value = "1.1.1.1,8.8.8.8" },
    ]
    secrets          = [{ name = "EGRESS_ALLOW_TOKEN", valueFrom = local.secret_arn["egress_token"] }]
    logConfiguration = merge(local.log, { options = merge(local.log.options, { "awslogs-stream-prefix" = "egress" }) })
  }])
}

resource "aws_ecs_service" "egress" {
  name            = "egress"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.egress.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.egress_proxy.id]
    assign_public_ip = true
  }
  service_registries { registry_arn = aws_service_discovery_service.egress.arn }
}

# ---- the run itself. Started by the API with a run token and the addresses of its state. No task role.
resource "aws_ecs_task_definition" "runner" {
  family                   = "${var.name}-runner"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.runner_cpu
  memory                   = var.runner_memory
  execution_role_arn       = aws_iam_role.execution.arn
  ephemeral_storage { size_in_gib = 40 }
  container_definitions = jsonencode([{
    name            = "runner"
    image           = local.runner_image
    essential       = true
    linuxParameters = { initProcessEnabled = true }
    # Time to save a parked run's files when the task is told to stop (the most Fargate allows).
    stopTimeout            = 120
    readonlyRootFilesystem = false
    environment = [
      { name = "SDLC_API_URL", value = local.api_private },
      { name = "SDLC_GATEWAY_URL", value = "http://gateway.${local.ns}:8787" },
      { name = "SDLC_MCP_URL", value = "${local.api_private}/mcp" },
      { name = "SDLC_WORK_DIR", value = "/work" },
      { name = "HTTPS_PROXY", value = local.proxy_url },
      { name = "https_proxy", value = local.proxy_url },
      { name = "NO_PROXY", value = ".${local.ns},localhost,127.0.0.1" },
      { name = "no_proxy", value = ".${local.ns},localhost,127.0.0.1" },
    ]
    logConfiguration = merge(local.log, { options = merge(local.log.options, { "awslogs-stream-prefix" = "runner" }) })
  }])
}

# ---- a preview of a pull request: its code arrives by a signed address, and it is told nothing about the platform
resource "aws_ecs_task_definition" "preview" {
  family                   = "${var.name}-preview"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.preview_cpu
  memory                   = var.preview_memory
  execution_role_arn       = aws_iam_role.execution.arn
  container_definitions = jsonencode([{
    name      = "preview"
    image     = local.runner_image
    essential = true
    command   = ["node", "/app/preview.mjs"]
    environment = [
      { name = "HTTPS_PROXY", value = local.proxy_url },
      { name = "https_proxy", value = local.proxy_url },
      { name = "NO_PROXY", value = "localhost,127.0.0.1" },
      { name = "no_proxy", value = "localhost,127.0.0.1" },
    ]
    logConfiguration = merge(local.log, { options = merge(local.log.options, { "awslogs-stream-prefix" = "preview" }) })
  }])
}

# ---- what the API may do to run them
resource "aws_iam_role_policy" "api_runs" {
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Action    = ["ecs:RunTask"]
        Resource  = ["arn:aws:ecs:${var.region}:${local.account}:task-definition/${aws_ecs_task_definition.runner.family}:*"]
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.main.arn } }
      },
      {
        Effect    = "Allow"
        Action    = ["ecs:RunTask"]
        Resource  = ["arn:aws:ecs:${var.region}:${local.account}:task-definition/${aws_ecs_task_definition.preview.family}:*"]
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.main.arn } }
      },
      {
        # To say what a preview printed when it did not come up.
        Effect   = "Allow"
        Action   = ["logs:GetLogEvents"]
        Resource = ["${aws_cloudwatch_log_group.platform.arn}:log-stream:preview/*"]
      },
      {
        Effect    = "Allow"
        Action    = ["ecs:StopTask", "ecs:DescribeTasks", "ecs:ListTasks"]
        Resource  = "*"
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.main.arn } }
      },
      {
        Effect   = "Allow"
        Action   = ["ecs:TagResource"]
        Resource = "arn:aws:ecs:${var.region}:${local.account}:task/${aws_ecs_cluster.main.name}/*"
      },
      {
        Effect    = "Allow"
        Action    = ["iam:PassRole"]
        Resource  = [aws_iam_role.execution.arn]
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      },
      {
        # The API signs the run's state URLs with its own permissions, so a URL can do no more than this.
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = ["${aws_s3_bucket.state.arn}/*"]
      },
      {
        # Without this, S3 answers 403 instead of 404 for an object that is not there, and a fresh run looks like a refusal.
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [aws_s3_bucket.state.arn]
      },
    ]
  })
}
