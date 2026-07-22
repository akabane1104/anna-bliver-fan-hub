param([string]$EnvFile = '.env')

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'docker-common.ps1')

$resolvedEnvFile = Resolve-ComposeEnvFile -EnvFile $EnvFile
$values = Assert-ComposeEnv -EnvFile $resolvedEnvFile
Assert-DockerAvailable

Invoke-DockerCompose -EnvFile $resolvedEnvFile -Arguments @('ps')

$frontendPort = Get-DotEnvValue -Values $values -Name 'FRONTEND_PORT' -Default '3000'
$backendPort = Get-DotEnvValue -Values $values -Name 'BACKEND_PORT' -Default '5000'
$checks = @(
    @{ Name = '前端'; Url = "http://localhost:$frontendPort/healthz" },
    @{ Name = '后端'; Url = "http://localhost:$backendPort/api/health" }
)

foreach ($check in $checks) {
    try {
        $response = Invoke-WebRequest -Uri $check.Url -UseBasicParsing -TimeoutSec 10
        Write-Host ("{0}检查：HTTP {1} {2}" -f $check.Name, $response.StatusCode, $check.Url)
    }
    catch {
        Write-Warning ("{0}检查失败：{1}" -f $check.Name, $_.Exception.Message)
    }
}
