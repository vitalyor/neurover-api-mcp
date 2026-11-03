# Neurover MCP one-line installer for Windows (PowerShell):
#   irm https://raw.githubusercontent.com/vitalyor/neurover-api-mcp/main/get.ps1 | iex
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # the PowerShell 5.1 progress bar makes downloads many times slower
$data = if ($env:NEUROVER_DATA_DIR) { $env:NEUROVER_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'NeuroverMCP' }
$private = Join-Path $data 'node\node.exe'
function Test-Node($exe) { try { & $exe -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=16)?0:1)"; $LASTEXITCODE -eq 0 } catch { $false } }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('neurover-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  if ((Test-Path $private) -and (Test-Node $private)) { $node = $private }
  elseif ((Get-Command node -ErrorAction SilentlyContinue) -and (Test-Node 'node')) { $node = (Get-Command node).Source }
  else {
    # No suitable Node.js: a private copy in the data folder. No admin rights; other programs and PATH are not touched.
    Write-Host 'Node.js 22.16+ not found. Downloading a private copy for Neurover MCP only (other programs are not affected)...'
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $v = (Invoke-RestMethod 'https://nodejs.org/dist/index.json' | Where-Object { $_.lts } | Select-Object -First 1).version
    $name = "node-$v-win-$arch"
    $zip = Join-Path $tmp "$name.zip"
    Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$v/$name.zip" -OutFile $zip
    $sums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$v/SHASUMS256.txt").Content
    $sum = ($sums -split "`n" | Where-Object { $_.Trim().EndsWith("  $name.zip") } | Select-Object -First 1) -replace ' .*', ''
    if (-not $sum -or (Get-FileHash $zip -Algorithm SHA256).Hash -ne $sum.ToUpper()) { throw 'The Node.js download is damaged. Run the command again.' }
    tar -xf $zip -C $tmp
    New-Item -ItemType Directory -Force -Path $data | Out-Null
    Remove-Item -Recurse -Force (Join-Path $data 'node') -ErrorAction SilentlyContinue
    Move-Item (Join-Path $tmp $name) (Join-Path $data 'node')
    $node = $private
    Write-Host "Node.js $v is ready."
  }
  $tgz = Join-Path $tmp 'source.tgz'
  Invoke-WebRequest -UseBasicParsing 'https://codeload.github.com/vitalyor/neurover-api-mcp/tar.gz/refs/heads/main' -OutFile $tgz
  New-Item -ItemType Directory -Path (Join-Path $tmp 'src') | Out-Null
  tar -xzf $tgz -C (Join-Path $tmp 'src') --strip-components=1
  & $node (Join-Path $tmp 'src/scripts/install.mjs')
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
