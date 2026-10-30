# feishu-bridge one-click installer (Windows)
#
# Usage (from the project folder):
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -NoSetup   # deps only, skip wizard
#   ...or just double-click install.cmd
#
# What it does:
#   1. Node >= 22.5 already on the system -> use it
#   2. otherwise -> download the official PORTABLE Node into .tools\node
#      (no install, no admin rights, system PATH untouched)
#   3. npm install
#   4. npm run setup (Feishu authorization + LLM key + business interview)
#
# Keep this file ASCII-only: Windows PowerShell 5.1 decodes BOM-less UTF-8
# scripts with the ANSI codepage, which would garble non-ASCII output.

[CmdletBinding()]
param(
  [switch]$NoSetup
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
Set-Location -LiteralPath $PSScriptRoot

$NodeDir = Join-Path $PSScriptRoot '.tools\node'
$usedPortable = $false

function Test-NodeExe([string]$exe) {
  if (-not $exe -or -not (Test-Path -LiteralPath $exe)) { return $false }
  try {
    $v = & $exe --version 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $v) { return $false }
    $m = [regex]::Match($v, 'v(\d+)\.(\d+)')
    if (-not $m.Success) { return $false }
    $maj = [int]$m.Groups[1].Value
    $min = [int]$m.Groups[2].Value
    return ($maj -gt 22) -or (($maj -eq 22) -and ($min -ge 5))
  } catch { return $false }
}

function Get-NodeVersion {
  # Pick a Node release >= 22.5 from the official index (already newest-first):
  # prefer LTS; fall back to any even-major line. Returns e.g. 'v22.20.0'.
  $idx = Invoke-RestMethod 'https://nodejs.org/dist/index.json' -TimeoutSec 60
  foreach ($pass in 0, 1) {
    foreach ($r in $idx) {
      if ($pass -eq 0) {
        if (-not $r.lts) { continue }                   # pass 0: LTS only
      } else {
        $m0 = [regex]::Match([string]$r.version, '^v(\d+)')
        if (-not $m0.Success -or ([int]$m0.Groups[1].Value % 2) -ne 0) { continue }  # pass 1: even majors
      }
      $m = [regex]::Match([string]$r.version, '^v(\d+)\.(\d+)')
      if (-not $m.Success) { continue }
      $maj = [int]$m.Groups[1].Value
      $min = [int]$m.Groups[2].Value
      if (($maj -gt 22) -or ($maj -eq 22 -and $min -ge 5)) { return [string]$r.version }
    }
  }
  return $null
}

Write-Host ''
Write-Host ' feishu-bridge one-click installer' -ForegroundColor White
Write-Host ''

$sysNode = (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (Test-NodeExe $sysNode) {
  Write-Host ("  System Node found: {0}" -f (& $sysNode --version)) -ForegroundColor Green
} elseif (Test-NodeExe (Join-Path $NodeDir 'node.exe')) {
  $env:PATH = "$NodeDir;$env:PATH"
  $usedPortable = $true
  Write-Host ("  Using project-local portable Node: {0}" -f (& (Join-Path $NodeDir 'node.exe') --version)) -ForegroundColor Green
} else {
  Write-Host '  Node >= 22.5 not found (required for built-in SQLite).' -ForegroundColor Yellow
  Write-Host '  Downloading official PORTABLE Node (~30 MB, no install, no admin)...' -ForegroundColor Cyan
  try {
    $ver = Get-NodeVersion
    if (-not $ver) { throw 'no >=22.5 release found on nodejs.org' }
    $zip = "node-$ver-win-x64.zip"
    $url = "https://nodejs.org/dist/$ver/$zip"
    $tmpZip = Join-Path $env:TEMP $zip
    $tmpDir = Join-Path $env:TEMP "node-extract-$PID"

    Invoke-WebRequest -Uri $url -OutFile $tmpZip -UseBasicParsing -TimeoutSec 600

    Write-Host '  Downloaded. Extracting into .tools\node ...'
    New-Item -ItemType Directory -Force -Path $NodeDir | Out-Null
    Expand-Archive -LiteralPath $tmpZip -DestinationPath $tmpDir -Force
    $inner = Get-ChildItem -LiteralPath $tmpDir -Directory -Filter 'node-*' | Select-Object -First 1
    if (-not $inner) { throw 'unexpected archive layout' }
    Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $NodeDir -Recurse -Force
    Remove-Item -LiteralPath $tmpZip, $tmpDir -Recurse -Force -ErrorAction SilentlyContinue

    if (-not (Test-NodeExe (Join-Path $NodeDir 'node.exe'))) { throw 'node still not runnable after extraction' }
    $env:PATH = "$NodeDir;$env:PATH"
    $usedPortable = $true
    Write-Host ("  Portable Node ready: {0}" -f (& (Join-Path $NodeDir 'node.exe') --version)) -ForegroundColor Green
  } catch {
    Write-Host ("  Auto-download failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
    Write-Host '  Fallback: install Node LTS manually from https://nodejs.org/ then re-run this script.'
    exit 1
  }
}

Write-Host ''
Write-Host '  Installing dependencies: npm install' -ForegroundColor Cyan
npm install --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { Write-Host '  npm install failed' -ForegroundColor Red; exit 1 }

if ($NoSetup) {
  Write-Host ''
  Write-Host '  Skipped the wizard. Run it later:  npm run setup' -ForegroundColor Cyan
} else {
  Write-Host ''
  Write-Host '  Starting the setup wizard: npm run setup' -ForegroundColor Cyan
  npm run setup
}

if ($usedPortable) {
  Write-Host ''
  Write-Host ("  NOTE: Node lives inside this project ({0})." -f $NodeDir) -ForegroundColor Yellow
  Write-Host '  - Background mode: double-click start-hidden.vbs or register the scheduled'
  Write-Host '  task (both find the portable node automatically).'
  Write-Host '  - In a NEW terminal before manual "npm start", run:'
  Write-Host ('      $env:PATH = "{0};$env:PATH"' -f $NodeDir)
}
