# Copies the two GitHub Apps from another stack (for example your local one) into this stack, so nobody has to register
# them again. Their private keys go into Secrets Manager; their rows go into the database through a one-off task of the
# platform image. Needs a backup file with the Apps' non-secret details and the other stack's secrets file.
#   ./import-github-apps.ps1 -Backup ..\..\.dev-data\github-apps.backup.json -SecretsFile ..\..\.dev-data\secrets.json
# The usual way is to register the Apps from the web app (/admin/github). This is for moving a working pair.
param(
  [Parameter(Mandatory)][string]$Backup,
  [Parameter(Mandatory)][string]$SecretsFile,
  [string]$Name = 'sdlc-dev', [string]$Profile = 'default', [string]$Region = 'us-east-1'
)
$ErrorActionPreference = 'Stop'
$env:AWS_PROFILE = $Profile
$prefix = terraform output -raw runtime_secret_prefix
$apps = (Get-Content $Backup -Raw | ConvertFrom-Json).apps
$stored = Get-Content $SecretsFile -Raw | ConvertFrom-Json

foreach ($kind in 'agent', 'gate') {
  foreach ($what in 'private_key', 'client_secret') {
    $value = $stored.PSObject.Properties["github/$kind/$what"].Value
    if (-not $value) { throw "no github/$kind/$what in $SecretsFile" }
    $id = "$prefix" + "github/$kind/$what"
    $file = New-TemporaryFile
    try {
      [IO.File]::WriteAllText($file.FullName, $value)
      # Native commands write to stderr when they fail, which PowerShell would turn into a stop. The exit code decides.
      $ErrorActionPreference = 'Continue'
      aws secretsmanager put-secret-value --region $Region --secret-id $id --secret-string "file://$($file.FullName)" 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0) {
        aws secretsmanager create-secret --region $Region --name $id --secret-string "file://$($file.FullName)" 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "could not store $id" }
      }
      $ErrorActionPreference = 'Stop'
    } finally { Remove-Item $file.FullName -Force }
    Write-Host "stored $id"
  }
}

$script = Get-Content (Join-Path $PSScriptRoot 'import-github-apps.ts') -Raw
$appsB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @($apps) -Depth 5)))
$scriptB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))
$subnet = aws ec2 describe-subnets --region $Region --filters "Name=tag:Name,Values=$Name-public-0" --query 'Subnets[0].SubnetId' --output text
$sg = aws ec2 describe-security-groups --region $Region --filters "Name=group-name,Values=$Name-tasks" --query 'SecurityGroups[0].GroupId' --output text
$overrides = @{ containerOverrides = @(@{
  name = 'api'
  command = @('sh', '-c', 'echo "$SCRIPT_B64" | base64 -d > apps/api/import-apps.ts && node --import tsx apps/api/import-apps.ts')
  environment = @(@{ name = 'APPS_B64'; value = $appsB64 }, @{ name = 'SCRIPT_B64'; value = $scriptB64 })
}) } | ConvertTo-Json -Depth 6 -Compress
$overridesFile = New-TemporaryFile
[IO.File]::WriteAllText($overridesFile.FullName, $overrides)
$task = aws ecs run-task --region $Region --cluster $Name --launch-type FARGATE --task-definition "$Name-api" `
  --network-configuration "awsvpcConfiguration={subnets=[$subnet],securityGroups=[$sg],assignPublicIp=ENABLED}" `
  --overrides "file://$($overridesFile.FullName)" --query 'tasks[0].taskArn' --output text
Remove-Item $overridesFile.FullName -Force
if (-not $task -or $task -eq 'None') { throw 'the import task did not start' }
$id = $task.Split('/')[-1]
Write-Host "import task $id started"
aws ecs wait tasks-stopped --region $Region --cluster $Name --tasks $task
Start-Sleep 5
aws logs get-log-events --region $Region --log-group-name "/$Name" --log-stream-name "api/api/$id" --query 'events[].message' --output text
