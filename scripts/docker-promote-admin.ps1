param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[^@\s]+@[^@\s]+\.[^@\s]+$')]
    [string]$Email,
    [string]$EnvFile = '.env'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'docker-common.ps1')

$resolvedEnvFile = Resolve-ComposeEnvFile -EnvFile $EnvFile
Assert-ComposeEnv -EnvFile $resolvedEnvFile | Out-Null
Assert-DockerAvailable

Invoke-DockerCompose -EnvFile $resolvedEnvFile -Arguments @(
    'exec', '-T', '-e', "ADMIN_EMAIL=$Email", 'backend', 'npm', 'run', 'admin:promote'
)
