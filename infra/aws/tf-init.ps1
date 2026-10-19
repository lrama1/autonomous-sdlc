# Shared by deploy.ps1 and destroy.ps1: point Terraform at the shared state in S3 (made by infra/bootstrap).
# Dot-source it:  . "$PSScriptRoot/tf-init.ps1"
function Initialize-Terraform([string]$Region) {
  $account = aws sts get-caller-identity --query Account --output text
  if ($LASTEXITCODE -ne 0 -or -not $account) { throw 'could not read the AWS account: are the credentials valid?' }
  $bucket = if ($env:TF_STATE_BUCKET) { $env:TF_STATE_BUCKET } else { "sdlc-tfstate-$account" }
  # -migrate-state -force-copy moves state from an older local file on first use and is a no-op afterwards.
  terraform init -input=false -migrate-state -force-copy "-backend-config=bucket=$bucket" '-backend-config=key=sdlc-dev/terraform.tfstate' "-backend-config=region=$Region" '-backend-config=use_lockfile=true' '-backend-config=encrypt=true'
  if ($LASTEXITCODE -ne 0) { throw "terraform init failed (exit $LASTEXITCODE). Has infra/bootstrap been applied?" }
}
