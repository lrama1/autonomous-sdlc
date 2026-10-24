# One-time setup, applied by a person with admin rights on the AWS account. It makes the two things the
# deploy workflow needs before it can run: a bucket for Terraform's state, and a role GitHub Actions can assume.
#   cd infra/bootstrap
#   terraform init
#   terraform apply -var repository=repo:OWNER@OWNER_ID/REPO@REPO_ID   # see the variable's description
#   Optional, tighter: add -var actor_id=YOUR_NUMERIC_GITHUB_ID -var workflow_ref=OWNER/REPO/.github/workflows/deploy.yml@refs/heads/main
# Its own state stays local (and is not committed): it holds no secrets and can be re-imported.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

variable "repository" {
  type        = string
  description = "The repository as it appears in GitHub's sign-in token (new repositories include their numeric ids, so a deleted and re-created name cannot inherit trust). Read it with: gh api repos/OWNER/NAME/actions/oidc/customization/sub  (use sub_claim_prefix)."
}

variable "environment" {
  type        = string
  default     = "production"
  description = "The GitHub Environment a deploy job must run in. It requires a reviewer and allows only the main branch, so the role cannot be assumed without that approval."
}

variable "actor_id" {
  type        = string
  default     = null
  description = "Optional. The numeric id of the one GitHub user whose runs may assume the deploy role (gh api users/NAME --jq .id). Null allows any user who can start the workflow."
}

variable "workflow_ref" {
  type        = string
  default     = null
  description = "Optional. The one workflow file that may assume the deploy role, as OWNER/REPO/.github/workflows/deploy.yml@refs/heads/main. Null allows any workflow in the environment."
}
variable "region" {
  type    = string
  default = "us-east-1"
}

variable "aws_profile" {
  type    = string
  default = "default"
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile
  default_tags {
    tags = { Project = "autonomous-sdlc", Stack = "bootstrap", ManagedBy = "terraform" }
  }
}

data "aws_caller_identity" "me" {}

locals {
  bucket = "sdlc-tfstate-${data.aws_caller_identity.me.account_id}"
}

resource "aws_s3_bucket" "state" {
  bucket = local.bucket
  # The state describes the whole stack. Never let a stray destroy take it with it.
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "TlsOnly"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

# Trust is the control here: only this repository's workflows, in the protected GitHub Environment, can assume the role.
resource "aws_iam_role" "deploy" {
  name = "sdlc-github-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = merge(
          {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
            "token.actions.githubusercontent.com:sub" = "${var.repository}:environment:${var.environment}"
          },
          var.actor_id == null ? {} : { "token.actions.githubusercontent.com:actor_id" = var.actor_id },
          var.workflow_ref == null ? {} : { "token.actions.githubusercontent.com:job_workflow_ref" = var.workflow_ref },
        )
      }
    }]
  })
}

# The stack creates IAM roles, VPCs, databases and CDNs, so a narrow policy would be long and brittle.
# Anyone who can approve a deployment to the environment can therefore act as an administrator of this account: keep the reviewers to people you trust, and protect the main branch.
resource "aws_iam_role_policy_attachment" "deploy_admin" {
  role       = aws_iam_role.deploy.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

output "deploy_role_arn" { value = aws_iam_role.deploy.arn }
output "state_bucket" { value = aws_s3_bucket.state.bucket }
