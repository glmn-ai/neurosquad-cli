# nsq installer for Windows — installs the npm package globally with the npm you have.
#
#   irm https://raw.githubusercontent.com/glmn-ai/neurosquad-cli/main/packaging/install/install.ps1 | iex
#
# Environment: NSQ_VERSION (default: latest), NSQ_PACKAGE (default: neurosquad).
# Needs Node.js >= 22.13 with npm. Installs nothing else and needs no administrator rights.
$ErrorActionPreference = 'Stop'

$package = if ($env:NSQ_PACKAGE) { $env:NSQ_PACKAGE } else { 'neurosquad' }
$version = if ($env:NSQ_VERSION) { $env:NSQ_VERSION } else { 'latest' }
$minNode = [version]'22.13.0'

function Fail([string]$message) { Write-Host "nsq: error: $message" -ForegroundColor Red; throw $message }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "Node.js $minNode or newer is required: winget install OpenJS.NodeJS.LTS (or https://nodejs.org), then open a new terminal."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm was not found next to Node.js.' }

$nodeVersion = [version]((node -p 'process.versions.node').Trim())
if ($nodeVersion -lt $minNode) { Fail "Node.js $nodeVersion is too old; nsq needs $minNode or newer." }
if ($version -ne 'latest' -and $version -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$') {
    Fail "NSQ_VERSION must be 'latest' or a version like 0.1.0"
}

Write-Host "nsq: installing $package@$version with npm $((npm -v).Trim()) (Node $nodeVersion)"
npm install --global --no-audit --no-fund "$package@$version"
if ($LASTEXITCODE -ne 0) { Fail "npm install failed with exit code $LASTEXITCODE" }

$prefix = (npm prefix -g).Trim()
if (Get-Command nsq -ErrorAction SilentlyContinue) {
    Write-Host "nsq: done ($((nsq --version) 2>$null)). Run 'nsq' to start."
} else {
    Write-Host "nsq: done. Open a new terminal, or add $prefix to your PATH."
}
