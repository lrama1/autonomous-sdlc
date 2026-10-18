terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region  = "us-east-1"
  profile = "default"
  default_tags {
    tags = { Project = "autonomous-sdlc-spike", Spike = "s3-fargate", Disposable = "true" }
  }
}

locals {
  name = "sdlc-spike"
  acct = data.aws_caller_identity.me.account_id
  ecr  = "${local.acct}.dkr.ecr.us-east-1.amazonaws.com/ecr-public/docker/library"
}

data "aws_caller_identity" "me" {}
data "aws_availability_zones" "az" { state = "available" }

# ---------------- network: one VPC, a public subnet (proxy) and an isolated subnet (runner) ----------------
resource "aws_vpc" "main" {
  cidr_block           = "10.50.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.name }
}

resource "aws_internet_gateway" "igw" { vpc_id = aws_vpc.main.id }

resource "aws_subnet" "public" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.50.0.0/24"
  availability_zone = data.aws_availability_zones.az.names[0]
  tags              = { Name = "${local.name}-public" }
}

resource "aws_subnet" "isolated" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.50.1.0/24"
  availability_zone = data.aws_availability_zones.az.names[0]
  tags              = { Name = "${local.name}-isolated" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "isolated" { vpc_id = aws_vpc.main.id }

resource "aws_route_table_association" "isolated" {
  subnet_id      = aws_subnet.isolated.id
  route_table_id = aws_route_table.isolated.id
}

# ---------------- security groups ----------------
resource "aws_security_group" "runner" {
  name   = "${local.name}-runner"
  vpc_id = aws_vpc.main.id
}

resource "aws_security_group" "proxy" {
  name   = "${local.name}-proxy"
  vpc_id = aws_vpc.main.id
}

resource "aws_security_group" "endpoints" {
  name   = "${local.name}-endpoints"
  vpc_id = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "proxy_from_runner" {
  security_group_id            = aws_security_group.proxy.id
  referenced_security_group_id = aws_security_group.runner.id
  ip_protocol                  = "tcp"
  from_port                    = 3128
  to_port                      = 3128
}

resource "aws_vpc_security_group_egress_rule" "proxy_out" {
  security_group_id = aws_security_group.proxy.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "runner_to_proxy" {
  security_group_id            = aws_security_group.runner.id
  referenced_security_group_id = aws_security_group.proxy.id
  ip_protocol                  = "tcp"
  from_port                    = 3128
  to_port                      = 3128
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

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_runner" {
  security_group_id            = aws_security_group.endpoints.id
  referenced_security_group_id = aws_security_group.runner.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

# ---------------- VPC endpoints so the isolated subnet can pull images and write logs ----------------
resource "aws_vpc_endpoint" "interface" {
  for_each            = toset(["ecr.api", "ecr.dkr", "logs"])
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.us-east-1.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.isolated.id]
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.us-east-1.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.isolated.id]
  # Only the bucket that holds ECR image layers. Blocks use of S3 as an exfiltration path.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = "*"
      Action    = ["s3:GetObject"]
      Resource  = ["arn:aws:s3:::prod-us-east-1-starport-layer-bucket/*"]
    }]
  })
}

# ---------------- images through an ECR pull-through cache (no Docker needed locally) ----------------
resource "aws_ecr_pull_through_cache_rule" "pub" {
  ecr_repository_prefix = "ecr-public"
  upstream_registry_url = "public.ecr.aws"
}

# ---------------- ECS ----------------
resource "aws_ecs_cluster" "c" { name = local.name }

resource "aws_cloudwatch_log_group" "l" {
  name              = "/sdlc-spike"
  retention_in_days = 1
}

resource "aws_iam_role" "exec" {
  name = "${local.name}-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "exec" {
  role       = aws_iam_role.exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ptc" {
  role = aws_iam_role.exec.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["ecr:CreateRepository", "ecr:BatchImportUpstreamImage", "ecr:TagResource"], Resource = "*" }]
  })
}

locals {
  log_cfg = { for n in ["proxy", "runner", "postgres"] : n => {
    logDriver = "awslogs"
    options   = { "awslogs-group" = aws_cloudwatch_log_group.l.name, "awslogs-region" = "us-east-1", "awslogs-stream-prefix" = n }
  } }
}

# Shared egress proxy. Runs in the public subnet with a public IP.
resource "aws_ecs_task_definition" "proxy" {
  family                   = "${local.name}-proxy"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.exec.arn
  container_definitions = jsonencode([{
    name             = "proxy"
    image            = "${local.ecr}/node:22-alpine"
    essential        = true
    command          = ["sh", "-c", "echo \"$PROXY_B64\" | base64 -d > /p.js && node /p.js"]
    environment      = [{ name = "PROXY_B64", value = filebase64("${path.module}/proxy.js") }, { name = "ALLOW", value = "openrouter.ai,github.com" }]
    logConfiguration = local.log_cfg["proxy"]
  }])
  depends_on = [aws_ecr_pull_through_cache_rule.pub]
}

# The sandbox: runner container plus a PostgreSQL sidecar. No task role.
resource "aws_ecs_task_definition" "verify" {
  family                   = "${local.name}-verify"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.exec.arn
  container_definitions = jsonencode([
    {
      name        = "postgres"
      image       = "${local.ecr}/postgres:16-alpine"
      essential   = true
      environment = [{ name = "POSTGRES_PASSWORD", value = "spike" }]
      healthCheck = { command = ["CMD-SHELL", "pg_isready -U postgres -h 127.0.0.1"], interval = 5, timeout = 3, retries = 10, startPeriod = 10 }
      logConfiguration = local.log_cfg["postgres"]
    },
    {
      name             = "runner"
      image            = "${local.ecr}/python:3.12-alpine"
      essential        = true
      command          = ["sh", "-c", "echo \"$SCRIPT_B64\" | base64 -d > /r.py && python /r.py"]
      environment      = [{ name = "SCRIPT_B64", value = filebase64("${path.module}/runner.py") }]
      dependsOn        = [{ containerName = "postgres", condition = "HEALTHY" }]
      logConfiguration = local.log_cfg["runner"]
    }
  ])
  depends_on = [aws_ecr_pull_through_cache_rule.pub]
}

output "cluster" { value = aws_ecs_cluster.c.name }
output "proxy_td" { value = aws_ecs_task_definition.proxy.arn }
output "verify_td" { value = aws_ecs_task_definition.verify.arn }
output "public_subnet" { value = aws_subnet.public.id }
output "isolated_subnet" { value = aws_subnet.isolated.id }
output "proxy_sg" { value = aws_security_group.proxy.id }
output "runner_sg" { value = aws_security_group.runner.id }

# ---------------- DNS allowlist for the VPC ----------------
resource "aws_route53_resolver_firewall_domain_list" "allow" {
  name    = "${local.name}-allow"
  domains = ["amazonaws.com", "*.amazonaws.com", "openrouter.ai", "*.openrouter.ai", "github.com", "*.github.com"]
}

resource "aws_route53_resolver_firewall_domain_list" "all" {
  name    = "${local.name}-all"
  domains = ["*"]
}

resource "aws_route53_resolver_firewall_rule_group" "rg" { name = "${local.name}-rg" }

resource "aws_route53_resolver_firewall_rule" "allow" {
  name                    = "allow-list"
  firewall_rule_group_id  = aws_route53_resolver_firewall_rule_group.rg.id
  firewall_domain_list_id = aws_route53_resolver_firewall_domain_list.allow.id
  priority                = 100
  action                  = "ALLOW"
}

resource "aws_route53_resolver_firewall_rule" "block" {
  name                    = "block-rest"
  firewall_rule_group_id  = aws_route53_resolver_firewall_rule_group.rg.id
  firewall_domain_list_id = aws_route53_resolver_firewall_domain_list.all.id
  priority                = 200
  action                  = "BLOCK"
  block_response          = "NXDOMAIN"
}

resource "aws_route53_resolver_firewall_rule_group_association" "a" {
  name                   = "${local.name}-assoc"
  firewall_rule_group_id = aws_route53_resolver_firewall_rule_group.rg.id
  vpc_id                 = aws_vpc.main.id
  priority               = 101
}
