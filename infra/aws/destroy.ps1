# Removes everything this stack made, including the secrets the API wrote at run time (GitHub App keys),
# which Terraform does not know about.
param([string]$Profile = 'default', [string]$Region = 'us-east-1')
$ErrorActionPreference = 'Stop'
if ($Profile) { $env:AWS_PROFILE = $Profile }
$env:TF_VAR_aws_profile = $Profile
. "$PSScriptRoot/tf-init.ps1"
Initialize-Terraform $Region
$prefix = terraform output -raw runtime_secret_prefix
$names = aws secretsmanager list-secrets --region $Region --filters "Key=name,Values=$prefix" --query 'SecretList[].Name' --output text
foreach ($n in ($names -split '\s+' | Where-Object { $_ })) {
  aws secretsmanager delete-secret --region $Region --secret-id $n --force-delete-without-recovery | Out-Null
  Write-Host "deleted secret $n"
}
terraform destroy -input=false -auto-approve
