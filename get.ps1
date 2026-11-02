# Neurover MCP one-line installer for Windows (PowerShell):
#   irm https://raw.githubusercontent.com/vitalyor/neurover-api-mcp/main/get.ps1 | iex
$ErrorActionPreference = 'Stop'
$need = 'Node.js 22.16+ is required. Install the LTS version from https://nodejs.org/ and run this command again.'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host $need; return }
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=16)?0:1)"
if ($LASTEXITCODE -ne 0) { Write-Host $need; return }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('neurover-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $tgz = Join-Path $tmp 'source.tgz'
  Invoke-WebRequest -UseBasicParsing 'https://codeload.github.com/vitalyor/neurover-api-mcp/tar.gz/refs/heads/main' -OutFile $tgz
  tar -xzf $tgz -C $tmp --strip-components=1
  node (Join-Path $tmp 'scripts/install.mjs')
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
