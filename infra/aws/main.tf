terraform {
  required_version = ">= 1.6"
  # The bucket is passed by tf-init.ps1 (it is named after the account). State is shared by your machine and CI.
  backend "s3" {}
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile == "" ? null : var.aws_profile
  default_tags {
    tags = { Project = "autonomous-sdlc", Stack = var.name, ManagedBy = "terraform" }
  }
}

# CloudFront reads its certificate from us-east-1, whatever region the rest of the stack runs in.
provider "aws" {
  alias   = "us_east_1"
  region  = "us-east-1"
  profile = var.aws_profile == "" ? null : var.aws_profile
  default_tags {
    tags = { Project = "autonomous-sdlc", Stack = var.name, ManagedBy = "terraform" }
  }
}

data "aws_caller_identity" "me" {}
data "aws_availability_zones" "az" { state = "available" }

locals {
  account        = data.aws_caller_identity.me.account_id
  azs            = slice(data.aws_availability_zones.az.names, 0, 2)
  custom_domain  = var.app_domain != ""
  public_url     = local.custom_domain ? "https://${var.app_domain}" : "https://${aws_cloudfront_distribution.edge.domain_name}"
  preview_origin = local.custom_domain ? "https://${var.preview_domain}" : "https://${aws_cloudfront_distribution.previews.domain_name}"
  issuer         = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.main.id}"
  image          = "${aws_ecr_repository.platform.repository_url}:${var.image_tag}"
  # Secrets that Terraform creates and ECS injects. The API creates its own under runtime/.
  runtime_prefix = "${var.name}/runtime/"
}

resource "aws_ecr_repository" "platform" {
  name         = "${var.name}-platform"
  force_delete = true
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_ecr_lifecycle_policy" "platform" {
  repository = aws_ecr_repository.platform.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 5 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
}
