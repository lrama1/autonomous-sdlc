param(
  [Parameter(Mandatory)][string]$Prompt,
  [Parameter(Mandatory)][string]$Log,
  [string]$Resume = '',
  [int]$MaxTurns = 12
)
# Runs Claude Code headless through the spike gateway with the platform MCP server attached.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:8787'
$env:ANTHROPIC_AUTH_TOKEN = 'run-tok-1'
$env:ANTHROPIC_API_KEY = ''
$env:ANTHROPIC_MODEL = 'agent-default'
if (-not [IO.Path]::IsPathRooted($Log)) { $Log = Join-Path $here $Log }
Set-Location (Join-Path $here 'work')
$args2 = @('-p', $Prompt, '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', (Join-Path $here 'mcp.json'),
  '--model', 'agent-default', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions',
  '--max-turns', $MaxTurns)
if ($Resume) { $args2 += @('--resume', $Resume) }
claude @args2 2>&1 | ForEach-Object { "$(Get-Date -Format HH:mm:ss.fff) $_" } | Out-File -FilePath $Log -Encoding utf8
