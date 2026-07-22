param(
    [string]$EnvFile = '.env',
    [string]$BackupRoot = 'backups'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'docker-common.ps1')

$resolvedEnvFile = Resolve-ComposeEnvFile -EnvFile $EnvFile
Assert-ComposeEnv -EnvFile $resolvedEnvFile | Out-Null
Assert-DockerAvailable

if (-not [IO.Path]::IsPathRooted($BackupRoot)) {
    $BackupRoot = Join-Path $script:RepositoryRoot $BackupRoot
}
$BackupRoot = [IO.Path]::GetFullPath($BackupRoot)
[IO.Directory]::CreateDirectory($BackupRoot) | Out-Null

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDirectory = Join-Path $BackupRoot $stamp
[IO.Directory]::CreateDirectory($backupDirectory) | Out-Null

$temporarySql = "anna-$stamp.sql"
$temporaryUploads = "anna-uploads-$stamp.tar.gz"
$databaseFile = Join-Path $backupDirectory 'mysql.sql'
$uploadsFile = Join-Path $backupDirectory 'uploads.tar.gz'

try {
    Invoke-DockerCompose -EnvFile $resolvedEnvFile -Arguments @(
        'exec', '-T', 'mysql', 'sh', '-c',
        "umask 077; mysqldump --user=root --password=`"`$MYSQL_ROOT_PASSWORD`" --single-transaction --routines --triggers `"`$MYSQL_DATABASE`" > /tmp/$temporarySql"
    )
    Invoke-DockerCompose -EnvFile $resolvedEnvFile -Arguments @('cp', "mysql:/tmp/$temporarySql", $databaseFile)

    Invoke-DockerCompose -EnvFile $resolvedEnvFile -Arguments @(
        'exec', '-T', 'backend', 'sh', '-c',
        "tar -czf /tmp/$temporaryUploads -C /app uploads"
    )
    Invoke-DockerCompose -EnvFile $resolvedEnvFile -Arguments @('cp', "backend:/tmp/$temporaryUploads", $uploadsFile)

    $manifest = [ordered]@{
        createdAt = (Get-Date).ToString('o')
        database = 'anna_bliver_fan_hub'
        databaseFile = 'mysql.sql'
        databaseSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $databaseFile).Hash
        uploadsFile = 'uploads.tar.gz'
        uploadsSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $uploadsFile).Hash
    }
    $manifestJson = $manifest | ConvertTo-Json
    $utf8WithoutBom = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText((Join-Path $backupDirectory 'manifest.json'), $manifestJson, $utf8WithoutBom)
}
finally {
    & docker compose --env-file $resolvedEnvFile --file $script:ComposeFile exec -T mysql rm -f "/tmp/$temporarySql" 2>$null
    & docker compose --env-file $resolvedEnvFile --file $script:ComposeFile exec -T backend rm -f "/tmp/$temporaryUploads" 2>$null
}

Write-Host "备份完成：$backupDirectory"
