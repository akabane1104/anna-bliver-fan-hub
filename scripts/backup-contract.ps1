Set-StrictMode -Version Latest

$script:BackupFormatVersion = 2
$script:DatabaseMetadataFormatVersion = 1

function Get-DatabaseMetadataComposeArguments {
    return @(
        'exec', '-T', 'mysql', 'sh', '-c',
        'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; mysql --batch --raw --skip-column-names --user=root --database="$MYSQL_DATABASE" --execute=''SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE();'''
    )
}

function Assert-MySqlIdentifier {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$FieldName
    )

    if ($Value.Length -lt 1 -or $Value.Length -gt 64 -or $Value -cnotmatch '^[A-Za-z0-9_]+$') {
        throw "$FieldName is not a supported MySQL identifier."
    }
    return $Value
}

function Get-RestoredDatabaseMetadataComposeArguments {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetDatabase
    )

    $validatedTarget = Assert-MySqlIdentifier `
        -Value $TargetDatabase `
        -FieldName 'targetDatabase'

    return @(
        'exec', '-T', 'mysql', 'sh', '-c',
        "export MYSQL_PWD=`"`$MYSQL_ROOT_PASSWORD`"; mysql --batch --raw --skip-column-names --user=root --database='$validatedTarget' --execute='SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE();'"
    )
}

function Write-BackupJson {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )

    $utf8WithoutBom = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText(
        $Path,
        ($Value | ConvertTo-Json -Depth 8),
        $utf8WithoutBom
    )
}

function Get-RequiredBackupProperty {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) {
        throw "Backup metadata is missing required field: $Name"
    }
    return $property.Value
}

function Assert-BackupFileHash {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Backup is incomplete; missing file: $Path"
    }
    if ($ExpectedSha256 -cnotmatch '^[A-Fa-f0-9]{64}$') {
        throw "$Label has an invalid SHA-256 value."
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash -ine $ExpectedSha256) {
        throw "$Label SHA-256 does not match manifest.json."
    }
}

function Assert-BackupFileRecord {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$ExpectedSize,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [Parameter(Mandatory = $true)][string]$Label
    )

    Assert-BackupFileHash -Path $Path -ExpectedSha256 $ExpectedSha256 -Label $Label
    try {
        $size = [Convert]::ToInt64($ExpectedSize)
    }
    catch {
        throw "$Label has an invalid size."
    }
    if ($size -le 0 -or (Get-Item -LiteralPath $Path).Length -ne $size) {
        throw "$Label size does not match manifest.json."
    }
}

function New-DatabaseMetadata {
    param(
        [Parameter(Mandatory = $true)][string]$SourceDatabase,
        [Parameter(Mandatory = $true)][string]$DefaultCharacterSet,
        [Parameter(Mandatory = $true)][string]$DefaultCollation
    )

    $source = Assert-MySqlIdentifier -Value $SourceDatabase -FieldName 'sourceDatabase'
    $characterSet = Assert-MySqlIdentifier `
        -Value $DefaultCharacterSet `
        -FieldName 'defaultCharacterSet'
    $collation = Assert-MySqlIdentifier -Value $DefaultCollation -FieldName 'defaultCollation'

    return [ordered]@{
        metadataFormatVersion = $script:DatabaseMetadataFormatVersion
        sourceDatabase = $source
        defaultCharacterSet = $characterSet
        defaultCollation = $collation
    }
}

function Resolve-BackupContract {
    param(
        [Parameter(Mandatory = $true)][string]$BackupDirectory,
        [switch]$AllowLegacyBackupWithoutDatabaseMetadata,
        [string]$LegacyDefaultCharacterSet = '',
        [string]$LegacyDefaultCollation = ''
    )

    $manifestPath = Join-Path $BackupDirectory 'manifest.json'
    $databasePath = Join-Path $BackupDirectory 'mysql.sql'
    $uploadsPath = Join-Path $BackupDirectory 'uploads.tar.gz'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Backup is incomplete; missing file: $manifestPath"
    }

    $manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding UTF8 | ConvertFrom-Json
    $versionProperty = $manifest.PSObject.Properties['backupFormatVersion']
    if ($null -eq $versionProperty) {
        if (-not $AllowLegacyBackupWithoutDatabaseMetadata) {
            throw 'Legacy backup lacks database defaults. Use the explicit legacy override and provide target defaults.'
        }

        $legacyCharacterSet = Assert-MySqlIdentifier `
            -Value $LegacyDefaultCharacterSet `
            -FieldName 'LegacyDefaultCharacterSet'
        $legacyCollation = Assert-MySqlIdentifier `
            -Value $LegacyDefaultCollation `
            -FieldName 'LegacyDefaultCollation'
        if ((Get-RequiredBackupProperty -Object $manifest -Name 'databaseFile') -cne 'mysql.sql') {
            throw 'Legacy databaseFile must be mysql.sql.'
        }
        if ((Get-RequiredBackupProperty -Object $manifest -Name 'uploadsFile') -cne 'uploads.tar.gz') {
            throw 'Legacy uploadsFile must be uploads.tar.gz.'
        }
        Assert-BackupFileHash `
            -Path $databasePath `
            -ExpectedSha256 (Get-RequiredBackupProperty -Object $manifest -Name 'databaseSha256') `
            -Label 'mysql.sql'
        Assert-BackupFileHash `
            -Path $uploadsPath `
            -ExpectedSha256 (Get-RequiredBackupProperty -Object $manifest -Name 'uploadsSha256') `
            -Label 'uploads.tar.gz'
        $legacySource = Assert-MySqlIdentifier `
            -Value (Get-RequiredBackupProperty -Object $manifest -Name 'database') `
            -FieldName 'database'
        Write-Warning 'Using explicit legacy override; the source backup does not contain database default metadata.'

        return [pscustomobject]@{
            BackupFormatVersion = 1
            IsLegacy = $true
            DatabaseFile = $databasePath
            UploadsFile = $uploadsPath
            MetadataFile = $null
            SourceDatabase = $legacySource
            DefaultCharacterSet = $legacyCharacterSet
            DefaultCollation = $legacyCollation
        }
    }

    try {
        $formatVersion = [Convert]::ToInt32($versionProperty.Value)
    }
    catch {
        throw 'backupFormatVersion is invalid.'
    }
    if ($formatVersion -ne $script:BackupFormatVersion) {
        throw "Unsupported backupFormatVersion: $formatVersion"
    }
    if ((Get-RequiredBackupProperty -Object $manifest -Name 'databaseFile') -cne 'mysql.sql') {
        throw 'databaseFile must be mysql.sql.'
    }
    if ((Get-RequiredBackupProperty -Object $manifest -Name 'uploadsFile') -cne 'uploads.tar.gz') {
        throw 'uploadsFile must be uploads.tar.gz.'
    }
    if (
        (Get-RequiredBackupProperty -Object $manifest -Name 'databaseMetadataFile') `
            -cne 'database-metadata.json'
    ) {
        throw 'databaseMetadataFile must be database-metadata.json.'
    }

    $metadataPath = Join-Path $BackupDirectory 'database-metadata.json'
    Assert-BackupFileRecord `
        -Path $databasePath `
        -ExpectedSize (Get-RequiredBackupProperty -Object $manifest -Name 'databaseSize') `
        -ExpectedSha256 (Get-RequiredBackupProperty -Object $manifest -Name 'databaseSha256') `
        -Label 'mysql.sql'
    Assert-BackupFileRecord `
        -Path $uploadsPath `
        -ExpectedSize (Get-RequiredBackupProperty -Object $manifest -Name 'uploadsSize') `
        -ExpectedSha256 (Get-RequiredBackupProperty -Object $manifest -Name 'uploadsSha256') `
        -Label 'uploads.tar.gz'
    Assert-BackupFileRecord `
        -Path $metadataPath `
        -ExpectedSize (Get-RequiredBackupProperty -Object $manifest -Name 'databaseMetadataSize') `
        -ExpectedSha256 (Get-RequiredBackupProperty -Object $manifest -Name 'databaseMetadataSha256') `
        -Label 'database-metadata.json'

    $metadata = Get-Content -Raw -LiteralPath $metadataPath -Encoding UTF8 | ConvertFrom-Json
    try {
        $metadataVersion = [Convert]::ToInt32(
            (Get-RequiredBackupProperty -Object $metadata -Name 'metadataFormatVersion')
        )
    }
    catch {
        throw 'metadataFormatVersion is invalid.'
    }
    if ($metadataVersion -ne $script:DatabaseMetadataFormatVersion) {
        throw "Unsupported metadataFormatVersion: $metadataVersion"
    }

    $sourceDatabase = Assert-MySqlIdentifier `
        -Value (Get-RequiredBackupProperty -Object $metadata -Name 'sourceDatabase') `
        -FieldName 'sourceDatabase'
    $defaultCharacterSet = Assert-MySqlIdentifier `
        -Value (Get-RequiredBackupProperty -Object $metadata -Name 'defaultCharacterSet') `
        -FieldName 'defaultCharacterSet'
    $defaultCollation = Assert-MySqlIdentifier `
        -Value (Get-RequiredBackupProperty -Object $metadata -Name 'defaultCollation') `
        -FieldName 'defaultCollation'

    if ((Get-RequiredBackupProperty -Object $manifest -Name 'database') -cne $sourceDatabase) {
        throw 'Manifest and database metadata source database do not match.'
    }
    if (
        (Get-RequiredBackupProperty -Object $manifest -Name 'databaseDefaultCharacterSet') `
            -cne $defaultCharacterSet
    ) {
        throw 'Manifest and database metadata default character set do not match.'
    }
    if (
        (Get-RequiredBackupProperty -Object $manifest -Name 'databaseDefaultCollation') `
            -cne $defaultCollation
    ) {
        throw 'Manifest and database metadata default collation do not match.'
    }

    return [pscustomobject]@{
        BackupFormatVersion = $formatVersion
        IsLegacy = $false
        DatabaseFile = $databasePath
        UploadsFile = $uploadsPath
        MetadataFile = $metadataPath
        SourceDatabase = $sourceDatabase
        DefaultCharacterSet = $defaultCharacterSet
        DefaultCollation = $defaultCollation
    }
}
