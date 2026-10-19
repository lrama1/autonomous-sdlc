terraform {
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.0" }
    random = { source = "hashicorp/random", version = "~> 3.0" }
  }
}

provider "aws" {
  region  = "us-east-1"
  profile = "default"
  default_tags {
    tags = { Project = "autonomous-sdlc-spike", Spike = "s6-fargate-runner", Disposable = "true" }
  }
}

variable "image_tag" {
  type    = string
  default = "spike"
}

locals {
  name   = "sdlc-s6"
  region = "us-east-1"
  acct   = data.aws_caller_identity.me.account_id
  image  = "${aws_ecr_repository.runner.repository_url}:${var.image_tag}"
  ns     = "sdlcs6.local"
}

data "aws_caller_identity" "me" {}
data "aws_availability_zones" "az" { state = "available" }

resource "random_id" "suffix" { byte_length = 3 }

# ---------------- image repository (the real runner image is pushed here) ----------------
resource "aws_ecr_repository" "runner" {
  name         = "${local.name}-runner"
  force_delete = true
}

# ---------------- state bucket (parked runs), and a second bucket the runner must NOT reach ----------------
resource "aws_s3_bucket" "state" {
  bucket        = "${local.name}-state-${random_id.suffix.hex}"
  force_destroy = true
}

resource "aws_s3_bucket" "other" {
  bucket        = "${local.name}-other-${random_id.suffix.hex}"
  force_destroy = true
}

# ---------------- network ----------------
resource "aws_vpc" "main" {
  cidr_block           = "10.51.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.name }
}

resource "aws_internet_gateway" "igw" { vpc_id = aws_vpc.main.id }

resource "aws_subnet" "public" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.51.0.0/24"
  availability_zone = data.aws_availability_zones.az.names[0]
  tags              = { Name = "${local.name}-public" }
}

resource "aws_subnet" "isolated" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.51.1.0/24"
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
resource "aws_security_group" "api" {
  name   = "${local.name}-api"
  vpc_id = aws_vpc.main.id
}
resource "aws_security_group" "endpoints" {
  name   = "${local.name}-endpoints"
  vpc_id = aws_vpc.main.id
}

# runner -> proxy, runner -> api (the stand-in for the platform), runner -> endpoints, runner -> S3 only
resource "aws_vpc_security_group_egress_rule" "runner_to_proxy" {
  security_group_id            = aws_security_group.runner.id
  referenced_security_group_id = aws_security_group.proxy.id
  ip_protocol                  = "tcp"
  from_port                    = 3128
  to_port                      = 3128
}
resource "aws_vpc_security_group_egress_rule" "runner_to_api" {
  security_group_id            = aws_security_group.runner.id
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
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
# the platform reaches a runner's own port (a preview)
resource "aws_vpc_security_group_ingress_rule" "runner_from_api" {
  security_group_id            = aws_security_group.runner.id
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = 4000
  to_port                      = 4000
}
resource "aws_vpc_security_group_ingress_rule" "proxy_from_runner" {
  security_group_id            = aws_security_group.proxy.id
  referenced_security_group_id = aws_security_group.runner.id
  ip_protocol                  = "tcp"
  from_port                    = 3128
  to_port                      = 3128
}
resource "aws_vpc_security_group_ingress_rule" "api_from_runner" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.runner.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
}
resource "aws_vpc_security_group_ingress_rule" "api_from_proxy" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.proxy.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
}
resource "aws_vpc_security_group_ingress_rule" "endpoints_from_runner" {
  security_group_id            = aws_security_group.endpoints.id
  referenced_security_group_id = aws_security_group.runner.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}
# The endpoints' private DNS names apply to the whole VPC. Tasks in the public subnet (the platform, the proxy) also
# resolve ECR and CloudWatch Logs to these addresses, so they must be allowed in too. Without this their logs stop.
resource "aws_vpc_security_group_ingress_rule" "endpoints_from_vpc" {
  security_group_id = aws_security_group.endpoints.id
  cidr_ipv4         = aws_vpc.main.cidr_block
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}
resource "aws_vpc_security_group_egress_rule" "proxy_out" {
  security_group_id = aws_security_group.proxy.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
resource "aws_vpc_security_group_egress_rule" "api_out" {
  security_group_id = aws_security_group.api.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# ---------------- VPC endpoints for the isolated subnet ----------------
resource "aws_vpc_endpoint" "interface" {
  for_each            = toset(["ecr.api", "ecr.dkr", "logs"])
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${local.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.isolated.id]
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${local.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.isolated.id]
  # The ECR layer bucket (image pulls) and the one state bucket. Any other bucket is refused.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Principal = "*", Action = ["s3:GetObject"], Resource = ["arn:aws:s3:::prod-${local.region}-starport-layer-bucket/*"] },
      { Effect = "Allow", Principal = "*", Action = ["s3:GetObject", "s3:PutObject"], Resource = ["${aws_s3_bucket.state.arn}/*"] },
    ]
  })
}

# ---------------- private names for the platform stand-in and the proxy ----------------
resource "aws_service_discovery_private_dns_namespace" "ns" {
  name = local.ns
  vpc  = aws_vpc.main.id
}

resource "aws_service_discovery_service" "api" {
  name = "api"
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.ns.id
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
    namespace_id = aws_service_discovery_private_dns_namespace.ns.id
    dns_records {
      ttl  = 10
      type = "A"
    }
  }
  health_check_custom_config { failure_threshold = 1 }
}

# ---------------- DNS allowlist for the whole VPC: private names and AWS services only ----------------
resource "aws_route53_resolver_firewall_domain_list" "allow" {
  name    = "${local.name}-allow"
  domains = [local.ns, "*.${local.ns}", "amazonaws.com", "*.amazonaws.com"]
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

# ---------------- ECS ----------------
resource "aws_ecs_cluster" "c" { name = local.name }

resource "aws_cloudwatch_log_group" "l" {
  name              = "/${local.name}"
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

locals {
  log = { for n in ["api", "proxy", "runner"] : n => {
    logDriver = "awslogs"
    options   = { "awslogs-group" = aws_cloudwatch_log_group.l.name, "awslogs-region" = local.region, "awslogs-stream-prefix" = n }
  } }
  run_script = "echo \"$SCRIPT_B64\" | base64 -d > /tmp/s.js && exec node /tmp/s.js"
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.exec.arn
  container_definitions = jsonencode([{
    name             = "api"
    image            = local.image
    essential        = true
    command          = ["sh", "-c", local.run_script]
    environment      = [{ name = "SCRIPT_B64", value = filebase64("${path.module}/stub.js") }]
    logConfiguration = local.log["api"]
  }])
}

resource "aws_ecs_task_definition" "proxy" {
  family                   = "${local.name}-proxy"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.exec.arn
  container_definitions = jsonencode([{
    name      = "proxy"
    image     = local.image
    essential = true
    command   = ["sh", "-c", local.run_script]
    environment = [
      { name = "SCRIPT_B64", value = filebase64("${path.module}/proxy.js") },
      { name = "ALLOW_URL", value = "http://api.${local.ns}:8080/egress-allow" },
    ]
    logConfiguration = local.log["proxy"]
  }])
}

# The sandbox. 2 vCPU and 4 GB, as a real run would use. No task role.
resource "aws_ecs_task_definition" "runner" {
  family                   = "${local.name}-runner"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 2048
  memory                   = 4096
  execution_role_arn       = aws_iam_role.exec.arn
  container_definitions = jsonencode([{
    name      = "runner"
    image     = local.image
    essential = true
    command   = ["sh", "-c", local.run_script]
    environment = [
      { name = "SCRIPT_B64", value = filebase64("${path.module}/probe.js") },
      { name = "API", value = "http://api.${local.ns}:8080" },
      { name = "PROXY", value = "egress.${local.ns}:3128" },
    ]
    logConfiguration = local.log["runner"]
  }])
}

resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.c.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = [aws_subnet.public.id]
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = true
  }
  service_registries { registry_arn = aws_service_discovery_service.api.arn }
}

resource "aws_ecs_service" "proxy" {
  name            = "proxy"
  cluster         = aws_ecs_cluster.c.id
  task_definition = aws_ecs_task_definition.proxy.arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = [aws_subnet.public.id]
    security_groups  = [aws_security_group.proxy.id]
    assign_public_ip = true
  }
  service_registries { registry_arn = aws_service_discovery_service.egress.arn }
}

output "cluster" { value = aws_ecs_cluster.c.name }
output "repository" { value = aws_ecr_repository.runner.repository_url }
output "runner_td" { value = aws_ecs_task_definition.runner.arn }
output "isolated_subnet" { value = aws_subnet.isolated.id }
output "runner_sg" { value = aws_security_group.runner.id }
output "state_bucket" { value = aws_s3_bucket.state.bucket }
output "other_bucket" { value = aws_s3_bucket.other.bucket }
output "log_group" { value = aws_cloudwatch_log_group.l.name }
