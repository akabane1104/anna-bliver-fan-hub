param(
    [string]$EnvFile = '.env',
    [string]$BackupRoot = 'backups'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'docker-common.ps1')
. (Join-Path $PSScriptRoot 'backup-contract.ps1')

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
$metadataFile = Join-Path $backupDirectory 'database-metadata.json'
$operationError = $null
$cleanupErrors = [Collections.Generic.List[string]]::new()

try {
    $metadataRows = @(
        Invoke-DockerCompose `
            -EnvFile $resolvedEnvFile `
            -Arguments (Get-DatabaseMetadataComposeArguments) |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
    if ($metadataRows.Count -ne 1) {
        throw "Expected one database metadata row, found $($metadataRows.Count)."
    }
    $metadataFields = @($metadataRows[0] -split "`t")
    if ($metadataFields.Count -ne 3) {
        throw "Expected three database metadata fields, found $($metadataFields.Count)."
    }
    $databaseMetadata = New-DatabaseMetadata `
        -SourceDatabase $metadataFields[0] `
        -DefaultCharacterSet $metadataFields[1] `
        -DefaultCollation $metadataFields[2]
    Write-BackupJson -Path $metadataFile -Value $databaseMetadata

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
        backupFormatVersion = $script:BackupFormatVersion
        createdAt = (Get-Date).ToString('o')
        database = $databaseMetadata.sourceDatabase
        databaseFile = 'mysql.sql'
        databaseSize = (Get-Item -LiteralPath $databaseFile).Length
        databaseSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $databaseFile).Hash
        uploadsFile = 'uploads.tar.gz'
        uploadsSize = (Get-Item -LiteralPath $uploadsFile).Length
        uploadsSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $uploadsFile).Hash
        databaseMetadataFile = 'database-metadata.json'
        databaseMetadataSize = (Get-Item -LiteralPath $metadataFile).Length
        databaseMetadataSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $metadataFile).Hash
        databaseDefaultCharacterSet = $databaseMetadata.defaultCharacterSet
        databaseDefaultCollation = $databaseMetadata.defaultCollation
    }
    Write-BackupJson -Path (Join-Path $backupDirectory 'manifest.json') -Value $manifest
    Resolve-BackupContract -BackupDirectory $backupDirectory | Out-Null
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
