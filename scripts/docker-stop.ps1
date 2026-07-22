param(
    [string]$EnvFile = '.env',
    [switch]$RemoveContainers
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'docker-common.ps1')

$resolvedEnvFile = Resolve-ComposeEnvFile -EnvFile $EnvFile
Assert-ComposeEnv -EnvFile $resolvedEnvFile | Out-Null
Assert-DockerAvailable

if ($RemoveContainers) {
    Invoke-DockerCompose -EnvFile $resolvedEnvFile -Arguments @('down')
    Write-Host '容器与网络已移除；MySQL 和 uploads 数据卷仍保留。'
}
else {
    Invoke-DockerCompose -EnvFile $resolvedEnvFile -Arguments @('stop')
    Write-Host '服务已停止；容器和数据卷仍保留。'
}
