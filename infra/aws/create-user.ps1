# Creates (or resets) a sign-in for one person in the Cognito user pool. People cannot sign themselves up.
#   ./create-user.ps1 -Email you@example.com
# Prints a password that works at once. Change it after the first sign-in if you like.
param([Parameter(Mandatory)][string]$Email, [string]$Profile = 'default', [string]$Region = 'us-east-1')
$ErrorActionPreference = 'Stop'
$env:AWS_PROFILE = $Profile
$pool = terraform output -raw cognito_user_pool_id
$chars = (48..57) + (65..90) + (97..122)
$password = -join ((1..18 | ForEach-Object { [char]($chars | Get-Random) })) + 'aA1'
aws cognito-idp admin-create-user --region $Region --user-pool-id $pool --username $Email `
  --user-attributes "Name=email,Value=$Email" "Name=email_verified,Value=true" --message-action SUPPRESS 2>$null | Out-Null
aws cognito-idp admin-set-user-password --region $Region --user-pool-id $pool --username $Email --password $password --permanent
Write-Host "Sign in at $(terraform output -raw url) as $Email with password: $password"
