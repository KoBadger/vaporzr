<#
.SYNOPSIS
Builds the bot image from a local copy of the repo.

.DESCRIPTION
Docker's BuildKit context upload fails when the repo lives under OneDrive
("invalid file request packages/core/src/analyzer.ts"), so this mirrors a
clean copy to %TEMP% first and builds from there. Generated output
(node_modules, dist, www, data, vendor, logs) is not copied.

.EXAMPLE
.\scripts\docker-build.ps1
.\scripts\docker-build.ps1 -Target build     # stop after npm ci (no librespot needed)
.\scripts\docker-build.ps1 -Tag vaporzr:test -NoCache
#>
param(
    [string]$Tag = 'vaporzr:local',
    [string]$Target = '',
    [switch]$NoCache
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$ctx = Join-Path $env:TEMP 'vaporzr-docker-build'

Write-Host "> syncing $repo -> $ctx"
robocopy $repo $ctx /MIR /XD node_modules .git dist www data vendor /XF *.log /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }

$dockerArgs = @('build', '-f', 'apps/bot/Dockerfile', '-t', $Tag)
if ($Target) { $dockerArgs += @('--target', $Target) }
if ($NoCache) { $dockerArgs += '--no-cache' }
$dockerArgs += '.'

Write-Host "> docker $($dockerArgs -join ' ')"
Push-Location $ctx
try {
    & docker @dockerArgs
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
