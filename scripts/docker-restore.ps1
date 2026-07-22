param(
    [Parameter(Mandatory = $true)][string]$BackupDirectory,
    [string]$EnvFile = '.env',
    [switch]$Force,
    [switch]$SkipSafetyBackup
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'docker-common.ps1')

$resolvedEnvFile = Resolve-ComposeEnvFile -EnvFile $EnvFile
Assert-ComposeEnv -EnvFile $resolvedEnvFile | Out-Null
Assert-DockerAvailable

if (-not [IO.Path]::IsPathRooted($BackupDirectory)) {
    $BackupDirectory = Join-Path $script:RepositoryRoot $BackupDirectory
}
$BackupDirectory = [IO.Path]::GetFullPath($BackupDirectory)
$databaseFile = Join-Path $BackupDirectory 'mysql.sql'
$uploadsFile = Join-Path $BackupDirectory 'uploads.tar.gz'
$manifestFile = Join-Path $BackupDirectory 'manifest.json'

foreach ($requiredFile in @($databaseFile, $uploadsFile)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "备份不完整，缺少：$requiredFile"
    }
}

if (Test-Path -LiteralPath $manifestFile -PathType Leaf) {
    $manifest = Get-Content -Raw -LiteralPath $manifestFile -Encoding UTF8 | ConvertFrom-Json
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $databaseFile).Hash -ne $manifest.databaseSha256) {
        throw 'mysql.sql 的 SHA-256 与 manifest.json 不一致。'
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $uploadsFile).Hash -ne $manifest.uploadsSha256) {
        throw 'uploads.tar.gz 的 SHA-256 与 manifest.json 不一致。'
    }
}

if (-not $Force) {
    $confirmation = Read-Host "还原会覆盖当前数据库和 uploads。输入 RESTORE 继续"
    if ($confirmation -cne 'RESTORE') {
        throw '已取消还原。'
    }
}

if (-not $SkipSafetyBackup) {
    Write-Host '还原前创建当前环境安全备份。'
    & (Join-Path $PSScriptRoot 'docker-backup.ps1') -EnvFile $resolvedEnvFile
    if ($LASTEXITCODE -ne 0) {
        throw '还原前安全备份失败。'
    }
}

$temporarySql = 'anna-restore.sql'
Invoke-DockerCompose -EnvFile $resolvedEnvFile -Arguments @('up', '--detach', '--wait', '--wait-timeout', '180', 'mysql')
Invoke-DockerCompose -EnvFile $resolvedEnvFile -Arguments @('stop', 'frontend', 'backend')

try {
    Invoke-DockerCompose -EnvFile $resolvedEnvFile -Arguments @('cp', $databaseFile, "mysql:/tmp/$temporarySql")
    Invoke-DockerCompose -EnvFile $resolvedEnvFile -Arguments @(
        'exec', '-T', 'mysql', 'sh', '-c',
        "mysql --user=root --password=`"`$MYSQL_ROOT_PASSWORD`" `"`$MYSQL_DATABASE`" < /tmp/$temporarySql"
    )

    Invoke-DockerCompose -EnvFile $resolvedEnvFile -Arguments @(
        'run', '--rm', '--no-deps', '--volume', "${BackupDirectory}:/restore:ro", 'backend', 'sh', '-c',
        'find /app/uploads -mindepth 1 -maxdepth 1 -exec rm -rf {} +; tar -xzf /restore/uploads.tar.gz -C /app'
    )
}
finally {
    & docker compose --env-file $resolvedEnvFile --file $script:ComposeFile exec -T mysql rm -f "/tmp/$temporarySql" 2>$null
}

Invoke-DockerCompose -EnvFile $resolvedEnvFile -Arguments @('up', '--detach', '--wait', '--wait-timeout', '300', 'backend', 'frontend')
Write-Host "还原完成：$BackupDirectory"
