Set-StrictMode -Version Latest

$script:RepositoryRoot = Split-Path -Parent $PSScriptRoot
$script:ComposeFile = Join-Path $script:RepositoryRoot 'docker-compose.yml'

function Resolve-ComposeEnvFile {
    param([string]$EnvFile = '.env')

    if ([IO.Path]::IsPathRooted($EnvFile)) {
        return [IO.Path]::GetFullPath($EnvFile)
    }

    return [IO.Path]::GetFullPath((Join-Path $script:RepositoryRoot $EnvFile))
}

function Get-DotEnvValues {
    param([Parameter(Mandatory = $true)][string]$EnvFile)

    $values = @{}
    foreach ($line in Get-Content -LiteralPath $EnvFile -Encoding UTF8) {
        $trimmed = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith('#')) {
            continue
        }

        $separator = $line.IndexOf('=')
        if ($separator -lt 1) {
            continue
        }

        $name = $line.Substring(0, $separator).Trim()
        $value = $line.Substring($separator + 1).Trim()
        if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $values[$name] = $value
    }

    return $values
}

function Get-DotEnvValue {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Values,
        [Parameter(Mandatory = $true)][string]$Name,
        [string]$Default = ''
    )

    if ($Values.ContainsKey($Name) -and -not [string]::IsNullOrWhiteSpace([string]$Values[$Name])) {
        return [string]$Values[$Name]
    }
    return $Default
}

function New-RandomSecret {
    param([int]$ByteCount = 48)

    $bytes = New-Object byte[] $ByteCount
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    }
    finally {
        $generator.Dispose()
    }
    return [Convert]::ToBase64String($bytes)
}

function Set-DotEnvValue {
    param(
        [Parameter(Mandatory = $true)][string]$Content,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Value,
        [switch]$OnlyIfMissingOrEmpty
    )

    $pattern = '(?m)^' + [Regex]::Escape($Name) + '=(.*)$'
    $match = [Regex]::Match($Content, $pattern)
    if ($match.Success) {
        if ($OnlyIfMissingOrEmpty -and -not [string]::IsNullOrWhiteSpace($match.Groups[1].Value)) {
            return $Content
        }
        return [Regex]::Replace($Content, $pattern, $Name + '=' + $Value, 1)
    }

    $separator = if ($Content.EndsWith("`n")) { '' } else { [Environment]::NewLine }
    return $Content + $separator + $Name + '=' + $Value + [Environment]::NewLine
}

function Initialize-ComposeEnv {
    param([Parameter(Mandatory = $true)][string]$EnvFile)

    $exampleFile = Join-Path $script:RepositoryRoot '.env.example'
    if (-not (Test-Path -LiteralPath $exampleFile)) {
        throw "找不到环境变量模板：$exampleFile"
    }

    $existing = Test-Path -LiteralPath $EnvFile
    $content = if ($existing) {
        Get-Content -Raw -LiteralPath $EnvFile -Encoding UTF8
    }
    else {
        Get-Content -Raw -LiteralPath $exampleFile -Encoding UTF8
    }

    if (-not $existing) {
        $content = Set-DotEnvValue -Content $content -Name 'MYSQL_ROOT_PASSWORD' -Value (New-RandomSecret -ByteCount 48)
        $content = Set-DotEnvValue -Content $content -Name 'MYSQL_PASSWORD' -Value (New-RandomSecret -ByteCount 48)
        $content = Set-DotEnvValue -Content $content -Name 'JWT_SECRET' -Value (New-RandomSecret -ByteCount 64)
    }
    $updated = Set-DotEnvValue `
        -Content $content `
        -Name 'LIVE_EVENT_REF_SECRET' `
        -Value (New-RandomSecret -ByteCount 48) `
        -OnlyIfMissingOrEmpty

    if (-not $existing -or $updated -cne $content) {
        $utf8WithoutBom = [Text.UTF8Encoding]::new($false)
        [IO.File]::WriteAllText($EnvFile, $updated, $utf8WithoutBom)
        Write-Host "已初始化本机环境文件：$EnvFile"
    }
    else {
        Write-Host "环境文件已包含 LIVE_EVENT_REF_SECRET，保持现有值：$EnvFile"
    }
}

function Assert-ComposeEnv {
    param([Parameter(Mandatory = $true)][string]$EnvFile)

    if (-not (Test-Path -LiteralPath $EnvFile)) {
        throw "找不到 $EnvFile。首次启动请使用 -Initialize，或先复制 .env.example 并填写密钥。"
    }

    $values = Get-DotEnvValues -EnvFile $EnvFile
    foreach ($name in @('MYSQL_ROOT_PASSWORD', 'MYSQL_PASSWORD', 'JWT_SECRET', 'LIVE_EVENT_REF_SECRET')) {
        $value = Get-DotEnvValue -Values $values -Name $name
        if ([string]::IsNullOrWhiteSpace($value) -or $value -match '(?i)replace[_-]?with|change[_-]?me|example[_-]?(?:password|secret)') {
            throw "$name 仍为空或使用示例占位值，请先在 $EnvFile 中设置安全随机值。"
        }
    }

    if ((Get-DotEnvValue -Values $values -Name 'JWT_SECRET').Length -lt 32) {
        throw 'JWT_SECRET 至少需要 32 个字符。'
    }

    $referenceSecret = Get-DotEnvValue -Values $values -Name 'LIVE_EVENT_REF_SECRET'
    if ([Text.Encoding]::UTF8.GetByteCount($referenceSecret) -lt 32) {
        throw 'LIVE_EVENT_REF_SECRET 至少需要 32 bytes。'
    }

    foreach ($name in @('MYSQL_ROOT_PASSWORD', 'MYSQL_PASSWORD', 'JWT_SECRET', 'LIVE_EVENT_INGEST_SECRET')) {
        $otherSecret = Get-DotEnvValue -Values $values -Name $name
        if (-not [string]::IsNullOrWhiteSpace($otherSecret) -and $referenceSecret -ceq $otherSecret) {
            throw "LIVE_EVENT_REF_SECRET 不得与 $name 共用。"
        }
    }

    return $values
}

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [string]$DisplayName = $FilePath
    )

    $stderrFile = [IO.Path]::GetTempFileName()
    $previousErrorActionPreference = $ErrorActionPreference
    $stdout = @()
    $exitCode = $null

    try {
        try {
            # Native stderr is diagnostic output; success is determined by ExitCode.
            $ErrorActionPreference = 'Continue'
            $stdout = @(& $FilePath @ArgumentList 2> $stderrFile)
            $exitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }

        $stderrLineCount = 0
        if (Test-Path -LiteralPath $stderrFile) {
            $stderrLineCount = @(
                Get-Content -LiteralPath $stderrFile -ErrorAction SilentlyContinue |
                    Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
            ).Count
        }

        if ($null -eq $exitCode) {
            throw "$DisplayName 未返回原生命令退出码。"
        }
        if ($exitCode -ne 0) {
            throw "$DisplayName 执行失败，退出码：$exitCode；已捕获 $stderrLineCount 行 stderr，内容已省略。"
        }

        if ($stdout.Count -gt 0) {
            $stdout
        }
        if ($stderrLineCount -gt 0) {
            Write-Warning "$DisplayName 已成功完成（退出码 0），并产生 $stderrLineCount 行已脱敏的 stderr 警告。"
        }
    }
    finally {
        Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
    }
}

function Assert-DockerAvailable {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw '找不到 docker 命令，请先启动 Docker Desktop 并确认 docker compose 可用。'
    }

    Invoke-NativeCommand `
        -FilePath 'docker' `
        -ArgumentList @('info', '--format', '{{.ServerVersion}}') `
        -DisplayName 'docker info' |
        Out-Null
}

function Invoke-DockerCompose {
    param(
        [Parameter(Mandatory = $true)][string]$EnvFile,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $dockerArguments = @('compose', '--env-file', $EnvFile, '--file', $script:ComposeFile) + $Arguments
    Invoke-NativeCommand `
        -FilePath 'docker' `
        -ArgumentList $dockerArguments `
        -DisplayName 'docker compose'
}
