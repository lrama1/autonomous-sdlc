# Creates (or resets) sign-ins in the Cognito user pool. People cannot sign themselves up.
#   ./create-user.ps1 -Email you@example.com
#   ./create-user.ps1 -UsersFile users.csv        # one email per line, or a CSV with an "email" column
# Prints a password that works at once for each person. Change it after the first sign-in if you like.
param(
  [string]$Email,
  [string]$UsersFile,
  [string]$Profile = 'default',
  [string]$Region = 'us-east-1'
)
$ErrorActionPreference = 'Stop'
if (-not $Email -and -not $UsersFile) { throw "Pass -Email or -UsersFile." }
if ($Email -and $UsersFile) { throw "Pass -Email or -UsersFile, not both." }
$env:AWS_PROFILE = $Profile
$pool = terraform output -raw cognito_user_pool_id
$chars = (48..57) + (65..90) + (97..122)

$emails = @()
if ($UsersFile) {
  if (-not (Test-Path $UsersFile)) { throw "Users file not found: $UsersFile" }
  $header = (Get-Content $UsersFile -TotalCount 1).Trim()
  if ($header -match 'email') {
    # CSV with an email column (case-insensitive).
    $emails = Import-Csv $UsersFile | ForEach-Object { $_.email }
  } else {
    # Plain text, one email per line.
    $emails = Get-Content $UsersFile
  }
  $emails = @($emails | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() })
  if ($emails.Count -eq 0) { throw "No emails found in $UsersFile." }
} else {
  $emails = @($Email)
}

foreach ($e in $emails) {
  $password = -join ((1..18 | ForEach-Object { [char]($chars | Get-Random) })) + 'aA1'
  aws cognito-idp admin-create-user --region $Region --user-pool-id $pool --username $e `
    --user-attributes "Name=email,Value=$e" "Name=email_verified,Value=true" --message-action SUPPRESS 2>$null | Out-Null
  aws cognito-idp admin-set-user-password --region $Region --user-pool-id $pool --username $e --password $password --permanent | Out-Null
  Write-Host "Sign in at $(terraform output -raw url) as $e with password: $password"
}
