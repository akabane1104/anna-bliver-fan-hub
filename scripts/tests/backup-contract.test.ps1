param([string]$ComposeEnvFile = '')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptsDirectory = Split-Path -Parent $PSScriptRoot
. (Join-Path $scriptsDirectory 'backup-contract.ps1')

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("afh-backup-contract-" + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$passed = 0

function Assert-Equal {
    param(
        [Parameter(Mandatory = $true)]$Actual,
        [Parameter(Mandatory = $true)]$Expected,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if ($Actual -cne $Expected) {
        throw "$Label expected '$Expected', received '$Actual'."
    }
}

function Assert-True {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if (-not $Condition) {
        throw "$Label expected true."
    }
}

function Assert-Throws {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Action,
        [Parameter(Mandatory = $true)][string]$Label
    )

    try {
        & $Action
    }
    catch {
        return
    }
    throw "$Label expected an exception."
}

function New-TestBackup {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [string]$CharacterSet = 'utf8mb4',
        [string]$Collation = 'utf8mb4_unicode_ci'
    )

    $directory = Join-Path $testRoot $Name
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $databasePath = Join-Path $directory 'mysql.sql'
    $uploadsPath = Join-Path $directory 'uploads.tar.gz'
    $metadataPath = Join-Path $directory 'database-metadata.json'
    [IO.File]::WriteAllText($databasePath, 'synthetic database dump', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllBytes($uploadsPath, [byte[]](31, 139, 8, 0, 1, 2, 3, 4))

    $metadata = New-DatabaseMetadata `
        -SourceDatabase 'anna_bliver_fan_hub' `
        -DefaultCharacterSet $CharacterSet `
        -DefaultCollation $Collation
    Write-BackupJson -Path $metadataPath -Value $metadata
    $manifest = [ordered]@{
        backupFormatVersion = $script:BackupFormatVersion
        createdAt = '2026-07-25T00:00:00.0000000Z'
        database = $metadata.sourceDatabase
        databaseFile = 'mysql.sql'
        databaseSize = (Get-Item -LiteralPath $databasePath).Length
        databaseSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $databasePath).Hash
        uploadsFile = 'uploads.tar.gz'
        uploadsSize = (Get-Item -LiteralPath $uploadsPath).Length
        uploadsSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $uploadsPath).Hash
        databaseMetadataFile = 'database-metadata.json'
        databaseMetadataSize = (Get-Item -LiteralPath $metadataPath).Length
        databaseMetadataSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $metadataPath).Hash
        databaseDefaultCharacterSet = $metadata.defaultCharacterSet
        databaseDefaultCollation = $metadata.defaultCollation
    }
    Write-BackupJson -Path (Join-Path $directory 'manifest.json') -Value $manifest
    return $directory
}

function New-LegacyTestBackup {
    param([Parameter(Mandatory = $true)][string]$Name)

    $directory = Join-Path $testRoot $Name
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $databasePath = Join-Path $directory 'mysql.sql'
    $uploadsPath = Join-Path $directory 'uploads.tar.gz'
    [IO.File]::WriteAllText($databasePath, 'legacy synthetic dump', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllBytes($uploadsPath, [byte[]](31, 139, 8, 0, 5, 6, 7, 8))
    $manifest = [ordered]@{
        createdAt = '2026-07-25T00:00:00.0000000Z'
        database = 'anna_bliver_fan_hub'
        databaseFile = 'mysql.sql'
        databaseSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $databasePath).Hash
        uploadsFile = 'uploads.tar.gz'
        uploadsSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $uploadsPath).Hash
    }
    Write-BackupJson -Path (Join-Path $directory 'manifest.json') -Value $manifest
    return $directory
}

function Invoke-Test {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Action
    )

    & $Action
    $script:passed++
    Write-Output "PASS $Name"
}

try {
    Invoke-Test 'v2 contract resolves metadata and files' {
        $directory = New-TestBackup -Name 'valid'
        $contract = Resolve-BackupContract -BackupDirectory $directory
        Assert-Equal -Actual $contract.BackupFormatVersion -Expected 2 -Label 'backup format'
        Assert-Equal -Actual $contract.SourceDatabase -Expected 'anna_bliver_fan_hub' -Label 'source database'
        Assert-Equal -Actual $contract.DefaultCharacterSet -Expected 'utf8mb4' -Label 'character set'
        Assert-Equal -Actual $contract.DefaultCollation -Expected 'utf8mb4_unicode_ci' -Label 'collation'
        Assert-True -Condition (-not $contract.IsLegacy) -Label 'v2 legacy flag'
    }

    Invoke-Test 'metadata checksum mismatch fails closed' {
        $directory = New-TestBackup -Name 'checksum'
        [IO.File]::AppendAllText(
            (Join-Path $directory 'database-metadata.json'),
            'tampered',
            [Text.UTF8Encoding]::new($false)
        )
        Assert-Throws -Action {
            Resolve-BackupContract -BackupDirectory $directory | Out-Null
        } -Label 'metadata checksum'
    }

    Invoke-Test 'manifest metadata mismatch fails closed' {
        $directory = New-TestBackup -Name 'cross-check'
        $manifestPath = Join-Path $directory 'manifest.json'
        $manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding UTF8 | ConvertFrom-Json
        $manifest.databaseDefaultCollation = 'utf8mb4_0900_ai_ci'
        Write-BackupJson -Path $manifestPath -Value $manifest
        Assert-Throws -Action {
            Resolve-BackupContract -BackupDirectory $directory | Out-Null
        } -Label 'metadata cross-check'
    }

    Invoke-Test 'unsafe MySQL identifiers are rejected' {
        Assert-Throws -Action {
            Assert-MySqlIdentifier -Value 'db-name;DROP' -FieldName 'TargetDatabase' | Out-Null
        } -Label 'unsafe identifier'
    }

    Invoke-Test 'legacy backups fail closed by default' {
        $directory = New-LegacyTestBackup -Name 'legacy-closed'
        Assert-Throws -Action {
            Resolve-BackupContract -BackupDirectory $directory | Out-Null
        } -Label 'legacy default'
    }

    Invoke-Test 'legacy backups require explicit defaults' {
        $directory = New-LegacyTestBackup -Name 'legacy-explicit'
        $contract = Resolve-BackupContract `
            -BackupDirectory $directory `
            -AllowLegacyBackupWithoutDatabaseMetadata `
            -LegacyDefaultCharacterSet 'utf8mb4' `
            -LegacyDefaultCollation 'utf8mb4_unicode_ci' `
            -WarningAction SilentlyContinue
        Assert-True -Condition $contract.IsLegacy -Label 'legacy flag'
        Assert-Equal -Actual $contract.DefaultCollation -Expected 'utf8mb4_unicode_ci' -Label 'legacy collation'
    }

    Invoke-Test 'PowerShell scripts parse without errors' {
        foreach ($path in @(
            (Join-Path $scriptsDirectory 'backup-contract.ps1'),
            (Join-Path $scriptsDirectory 'docker-backup.ps1'),
            (Join-Path $scriptsDirectory 'docker-restore.ps1')
        )) {
            $tokens = $null
            $errors = $null
            [Management.Automation.Language.Parser]::ParseFile(
                $path,
                [ref]$tokens,
                [ref]$errors
            ) | Out-Null
            Assert-Equal -Actual $errors.Count -Expected 0 -Label "$path parser errors"
        }
    }

    Invoke-Test 'backup and restore scripts enforce metadata flow' {
        $contractSource = Get-Content -Raw -LiteralPath (Join-Path $scriptsDirectory 'backup-contract.ps1')
        $backupSource = Get-Content -Raw -LiteralPath (Join-Path $scriptsDirectory 'docker-backup.ps1')
        $restoreSource = Get-Content -Raw -LiteralPath (Join-Path $scriptsDirectory 'docker-restore.ps1')
        Assert-True `
            -Condition $contractSource.Contains('information_schema.SCHEMATA') `
            -Label 'backup contract schema metadata query'
        Assert-True `
            -Condition $backupSource.Contains('Get-DatabaseMetadataComposeArguments') `
            -Label 'backup metadata argument helper'
        Assert-True `
            -Condition $backupSource.Contains('database-metadata.json') `
            -Label 'backup metadata file'
        Assert-True `
            -Condition $restoreSource.Contains('ALTER DATABASE') `
            -Label 'restore database defaults'
        Assert-True `
            -Condition $restoreSource.Contains('information_schema.SCHEMATA') `
            -Label 'restore metadata verification'
        Assert-True `
            -Condition (-not $restoreSource.Contains('--password=')) `
            -Label 'restore command line password exclusion'
    }

    if (-not [string]::IsNullOrWhiteSpace($ComposeEnvFile)) {
        . (Join-Path $scriptsDirectory 'docker-common.ps1')
        $resolvedComposeEnvFile = Resolve-ComposeEnvFile -EnvFile $ComposeEnvFile
        $composeValues = Assert-ComposeEnv -EnvFile $resolvedComposeEnvFile
        $expectedDatabase = Get-DotEnvValue `
            -Values $composeValues `
            -Name 'MYSQL_DATABASE' `
            -Default 'anna_bliver_fan_hub'
        Assert-DockerAvailable

        Invoke-Test 'real Compose metadata query preserves the complete SQL argument' {
            $rows = @(
                Invoke-DockerCompose `
                    -EnvFile $resolvedComposeEnvFile `
                    -Arguments (Get-DatabaseMetadataComposeArguments) |
                    Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
            )
            Assert-Equal -Actual $rows.Count -Expected 1 -Label 'Compose metadata row count'
            $fields = @($rows[0] -split "`t")
            Assert-Equal -Actual $fields.Count -Expected 3 -Label 'Compose metadata field count'
            Assert-Equal -Actual $fields[0] -Expected $expectedDatabase -Label 'Compose source database'
            Assert-Equal -Actual $fields[1] -Expected 'utf8mb4' -Label 'Compose character set'
            Assert-Equal -Actual $fields[2] -Expected 'utf8mb4_unicode_ci' -Label 'Compose collation'
        }
    }

    Write-Output "RESULT passed=$passed failed=0"
}
finally {
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
