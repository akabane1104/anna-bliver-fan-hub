param(
    [string]$EnvFile = '.env',
    [switch]$Initialize,
    [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'docker-common.ps1')

$resolvedEnvFile = Resolve-ComposeEnvFile -EnvFile $EnvFile
if ($Initialize -and -not (Test-Path -LiteralPath $resolvedEnvFile)) {
    Initialize-ComposeEnv -EnvFile $resolvedEnvFile
}

$values = Assert-ComposeEnv -EnvFile $resolvedEnvFile
Assert-DockerAvailable

$arguments = @('up', '--detach')
if (-not $NoBuild) {
    $arguments += '--build'
}
$arguments += @('--wait', '--wait-timeout', '300')

Invoke-DockerCompose -EnvFile $resolvedEnvFile -Arguments $arguments

$frontendPort = Get-DotEnvValue -Values $values -Name 'FRONTEND_PORT' -Default '3000'
$backendPort = Get-DotEnvValue -Values $values -Name 'BACKEND_PORT' -Default '5000'
Write-Host "前端：http://localhost:$frontendPort"
Write-Host "后端健康检查：http://localhost:$backendPort/api/health"
