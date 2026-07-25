param(
    [Parameter(Mandatory = $true)][string]$BackupDirectory,
    [string]$EnvFile = '.env',
    [string]$TargetDatabase = '',
    [switch]$Force,
    [switch]$SkipSafetyBackup,
    [switch]$AllowLegacyBackupWithoutDatabaseMetadata,
    [string]$LegacyDefaultCharacterSet = '',
    [string]$LegacyDefaultCollation = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'docker-common.ps1')
. (Join-Path $PSScriptRoot 'backup-contract.ps1')

$resolvedEnvFile = Resolve-ComposeEnvFile -EnvFile $EnvFile
$composeEnvValues = Assert-ComposeEnv -EnvFile $resolvedEnvFile
Assert-DockerAvailable

if (-not [IO.Path]::IsPathRooted($BackupDirectory)) {
    $BackupDirectory = Join-Path $script:RepositoryRoot $BackupDirectory
}
$BackupDirectory = [IO.Path]::GetFullPath($BackupDirectory)
$resolvedTargetDatabase = if ([string]::IsNullOrWhiteSpace($TargetDatabase)) {
    Get-DotEnvValue `
        -Values $composeEnvValues `
        -Name 'MYSQL_DATABASE' `
        -Default 'anna_bliver_fan_hub'
}
else {
    $TargetDatabase
}
$targetDatabaseName = Assert-MySqlIdentifier `
    -Value $resolvedTargetDatabase `
    -FieldName 'TargetDatabase'
$backupContract = Resolve-BackupContract `
    -BackupDirectory $BackupDirectory `
    -AllowLegacyBackupWithoutDatabaseMetadata:$AllowLegacyBackupWithoutDatabaseMetadata `
    -LegacyDefaultCharacterSet $LegacyDefaultCharacterSet `
    -LegacyDefaultCollation $LegacyDefaultCollation
$databaseFile = $backupContract.DatabaseFile
$uploadsFile = $backupContract.UploadsFile

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

$temporarySql = "anna-restore-$([Guid]::NewGuid().ToString('N')).sql"
Invoke-DockerCompose -EnvFile $resolvedEnvFile -Arguments @('up', '--detach', '--wait', '--wait-timeout', '180', 'mysql')
Invoke-DockerCompose -EnvFile $resolvedEnvFile -Arguments @('stop', 'frontend', 'backend')

try {
    $databaseDefaultsSql = "CREATE DATABASE IF NOT EXISTS ``$targetDatabaseName`` CHARACTER SET $($backupContract.DefaultCharacterSet) COLLATE $($backupContract.DefaultCollation); ALTER DATABASE ``$targetDatabaseName`` CHARACTER SET $($backupContract.DefaultCharacterSet) COLLATE $($backupContract.DefaultCollation);"
    Invoke-DockerCompose -EnvFile $resolvedEnvFile -Arguments @(
        'exec', '-T', 'mysql', 'sh', '-c',
        "export MYSQL_PWD=`"`$MYSQL_ROOT_PASSWORD`"; mysql --user=root --execute='$databaseDefaultsSql'"
    )

    Invoke-DockerCompose -EnvFile $resolvedEnvFile -Arguments @('cp', $databaseFile, "mysql:/tmp/$temporarySql")
    Invoke-DockerCompose -EnvFile $resolvedEnvFile -Arguments @(
        'exec', '-T', 'mysql', 'sh', '-c',
        "export MYSQL_PWD=`"`$MYSQL_ROOT_PASSWORD`"; mysql --user=root --database='$targetDatabaseName' < /tmp/$temporarySql"
    )

    $restoredDefaults = @(
        Invoke-DockerCompose -EnvFile $resolvedEnvFile -Arguments @(
            'exec', '-T', 'mysql', 'sh', '-c',
            "export MYSQL_PWD=`"`$MYSQL_ROOT_PASSWORD`"; mysql --batch --raw --skip-column-names --user=root --database='$targetDatabaseName' --execute=`"SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE();`""
        ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
    if ($restoredDefaults.Count -ne 1) {
        throw "Expected one restored database metadata row, found $($restoredDefaults.Count)."
    }
    $restoredFields = @($restoredDefaults[0] -split "`t")
    if (
        $restoredFields.Count -ne 2 -or
        $restoredFields[0] -cne $backupContract.DefaultCharacterSet -or
        $restoredFields[1] -cne $backupContract.DefaultCollation
    ) {
        throw 'Restored database default character set or collation does not match the backup.'
    }

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
