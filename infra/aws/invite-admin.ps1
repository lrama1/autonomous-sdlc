# Invites the first admin: creates their sign-in in Cognito and has Cognito email them a temporary password and the platform address.
#   ./invite-admin.ps1 -Email you@example.com
# Safe to run again. If the person already exists nothing changes, unless you pass -Resend, which sends a new temporary
# password to someone who has not signed in yet. The Deploy workflow runs this after every deployment.
param(
  [Parameter(Mandatory)][string]$Email,
  [string]$PoolId,
  [string]$Region = 'us-east-1',
  [switch]$Resend
)
$ErrorActionPreference = 'Stop'
if (-not $PoolId) { $PoolId = terraform output -raw cognito_user_pool_id }
if (-not $PoolId) { throw 'Could not read the user pool id. Run this in infra/aws after a deployment, or pass -PoolId.' }

# Native tools write to stderr, so success is judged by the exit code.
$ErrorActionPreference = 'Continue'
$status = (& aws cognito-idp admin-get-user --region $Region --user-pool-id $PoolId --username $Email --query UserStatus --output text 2>&1 | Out-String).Trim()
$found = $LASTEXITCODE -eq 0
$ErrorActionPreference = 'Stop'
if ($found) {
  if ($status -eq 'FORCE_CHANGE_PASSWORD' -and $Resend) {
    aws cognito-idp admin-create-user --region $Region --user-pool-id $PoolId --username $Email `
      --message-action RESEND --desired-delivery-mediums EMAIL | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not resend the invitation.' }
    Write-Host "A new temporary password was emailed to $Email."
  } else {
    Write-Host "$Email already has a sign-in (status: $status). Nothing to do."
  }
  return
}
if ("$status" -notmatch 'UserNotFoundException') { throw "Could not look up ${Email}: $status" }

# No password is passed: Cognito makes a temporary one and emails it with the invitation text from the user pool.
aws cognito-idp admin-create-user --region $Region --user-pool-id $PoolId --username $Email `
  --user-attributes "Name=email,Value=$Email" 'Name=email_verified,Value=true' `
  --desired-delivery-mediums EMAIL | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not create the sign-in for $Email." }
Write-Host "Invited $Email. Cognito emailed a temporary password and the platform address."
