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
$operationError = $null
$cleanupErrors = [Collections.Generic.List[string]]::new()

try {
    Invoke-DockerCompose -EnvFile $resolvedEnvFile -Arguments @(
        'exec', '-T', 'mysql', 'sh', '-c',
        "umask 077; export MYSQL_PWD=`"`$MYSQL_ROOT_PASSWORD`"; mysqldump --user=root --single-transaction --quick --default-character-set=utf8mb4 --routines --triggers --events `"`$MYSQL_DATABASE`" > /tmp/$temporarySql"
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
catch {
    $operationError = $_
}
finally {
    try {
        Invoke-DockerCompose -EnvFile $resolvedEnvFile -Arguments @(
            'exec', '-T', 'mysql', 'rm', '-f', "/tmp/$temporarySql"
        ) | Out-Null
    }
    catch {
        $cleanupErrors.Add('MySQL 临时文件清理失败。')
    }

    try {
        Invoke-DockerCompose -EnvFile $resolvedEnvFile -Arguments @(
            'exec', '-T', 'backend', 'rm', '-f', "/tmp/$temporaryUploads"
        ) | Out-Null
    }
    catch {
        $cleanupErrors.Add('uploads 临时文件清理失败。')
    }
}

if ($null -ne $operationError) {
    if ($cleanupErrors.Count -gt 0) {
        throw "备份失败；$($cleanupErrors -join ' ')"
    }
    throw $operationError
}
if ($cleanupErrors.Count -gt 0) {
    throw "备份文件已生成，但容器临时文件清理失败；$($cleanupErrors -join ' ')"
}

Write-Host "备份完成：$backupDirectory"
