$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$packageInfoPath = Join-Path $projectRoot 'dist/latest-package.json'
if (-not (Test-Path -LiteralPath $packageInfoPath)) {
    throw 'Run node scripts/m0.mjs package first.'
}
$packageInfo = Get-Content -LiteralPath $packageInfoPath -Raw | ConvertFrom-Json
$applicationPath = Join-Path $packageInfo.target 'MANGA-M0.exe'
if (-not (Test-Path -LiteralPath $applicationPath)) { throw 'Packaged prototype executable is missing.' }
$env:MANGA_M0_DIR = Join-Path $env:LOCALAPPDATA 'MANGA-M0-review'
Start-Process -FilePath $applicationPath -WorkingDirectory $packageInfo.target -WindowStyle Normal
