# One-time setup, applied by a person with admin rights on the AWS account. It makes the two things the
# deploy workflow needs before it can run: a bucket for Terraform's state, and a role GitHub Actions can assume.
#   cd infra/bootstrap
#   terraform init
#   terraform apply -var repository=repo:lrama1@5783118/autonomous-sdlc@1423309795   # see the variable's description
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

variable "branch" {
  type        = string
  default     = "main"
  description = "The only branch whose workflows may assume the deploy role."
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

# Trust is the control here: only this repository's workflows on this branch can assume the role.
resource "aws_iam_role" "deploy" {
  name = "sdlc-github-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "${var.repository}:ref:refs/heads/${var.branch}"
        }
      }
    }]
  })
}

# The stack creates IAM roles, VPCs, databases and CDNs, so a narrow policy would be long and brittle.
# Anyone who can push to the branch can therefore act as an administrator of this account: protect the branch.
resource "aws_iam_role_policy_attachment" "deploy_admin" {
  role       = aws_iam_role.deploy.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

output "deploy_role_arn" { value = aws_iam_role.deploy.arn }
output "state_bucket" { value = aws_s3_bucket.state.bucket }
