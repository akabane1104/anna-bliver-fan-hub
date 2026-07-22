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

function Initialize-ComposeEnv {
    param([Parameter(Mandatory = $true)][string]$EnvFile)

    if (Test-Path -LiteralPath $EnvFile) {
        throw "环境文件已存在，不会覆盖：$EnvFile"
    }

    $exampleFile = Join-Path $script:RepositoryRoot '.env.example'
    if (-not (Test-Path -LiteralPath $exampleFile)) {
        throw "找不到环境变量模板：$exampleFile"
    }

    $content = Get-Content -Raw -LiteralPath $exampleFile -Encoding UTF8
    $replacements = @{
        MYSQL_ROOT_PASSWORD = (New-RandomSecret -ByteCount 48)
        MYSQL_PASSWORD = (New-RandomSecret -ByteCount 48)
        JWT_SECRET = (New-RandomSecret -ByteCount 64)
    }

    foreach ($name in $replacements.Keys) {
        $pattern = '(?m)^' + [Regex]::Escape($name) + '=.*$'
        $content = [Regex]::Replace($content, $pattern, $name + '=' + $replacements[$name])
    }

    $utf8WithoutBom = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText($EnvFile, $content, $utf8WithoutBom)
    Write-Host "已生成本机环境文件：$EnvFile"
}

function Assert-ComposeEnv {
    param([Parameter(Mandatory = $true)][string]$EnvFile)

    if (-not (Test-Path -LiteralPath $EnvFile)) {
        throw "找不到 $EnvFile。首次启动请使用 -Initialize，或先复制 .env.example 并填写密钥。"
    }

    $values = Get-DotEnvValues -EnvFile $EnvFile
    foreach ($name in @('MYSQL_ROOT_PASSWORD', 'MYSQL_PASSWORD', 'JWT_SECRET')) {
        $value = Get-DotEnvValue -Values $values -Name $name
        if ([string]::IsNullOrWhiteSpace($value) -or $value -match '(?i)replace[_-]?with|change[_-]?me|example[_-]?password') {
            throw "$name 仍为空或使用示例占位值，请先在 $EnvFile 中设置安全随机值。"
        }
    }

    if ((Get-DotEnvValue -Values $values -Name 'JWT_SECRET').Length -lt 32) {
        throw 'JWT_SECRET 至少需要 32 个字符。'
    }

    return $values
}

function Assert-DockerAvailable {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw '找不到 docker 命令，请先启动 Docker Desktop 并确认 docker compose 可用。'
    }

    & docker info --format '{{.ServerVersion}}' | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker Engine 当前不可用，请确认 Docker Desktop 已完成启动。'
    }
}

function Invoke-DockerCompose {
    param(
        [Parameter(Mandatory = $true)][string]$EnvFile,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $dockerArguments = @('compose', '--env-file', $EnvFile, '--file', $script:ComposeFile) + $Arguments
    & docker @dockerArguments
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose 执行失败，退出码：$LASTEXITCODE"
    }
}
