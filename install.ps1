# install.ps1 — dsh-auto-workspace 一键安装
# 兼容 Windows PowerShell 5.1 与 PowerShell 7。
# 用法：
#   .\install.ps1                  安装到默认 profile（用户目录下 .dsh\profiles 里的唯一 profile）
#   .\install.ps1 desktop          安装到名为 desktop 的 profile
#   .\install.ps1 C:\path\profile  安装到指定 profile 目录（含 package.json）
# 远程一键：irm https://raw.githubusercontent.com/Feiyuwan09/dsh-auto-workspace/main/install.ps1 | iex
# 恢复：脚本修改前会在 profile 里生成 package.json.bak-auto-workspace-<时间戳> 备份。
param([string]$ProfileArg)

$ErrorActionPreference = 'Stop'

function Fail([string]$msg) {
    Write-Host ""
    Write-Host " [错误] $msg" -ForegroundColor Red
    Write-Host ""
    exit 1
}
function Step([string]$msg) { Write-Host " $msg" -ForegroundColor Cyan }

# ---------- 0. 定位插件源码（支持远程 irm|iex 管道执行） ----------
$srcDir = $null
if ($PSCommandPath) {
    $srcDir = Split-Path -Parent $PSCommandPath
} else {
    $dlRoot = Join-Path $env:TEMP 'dsh-auto-workspace-download'
    $zipPath = Join-Path $env:TEMP 'dsh-auto-workspace.zip'
    if (Test-Path $dlRoot) { Remove-Item $dlRoot -Recurse -Force }
    New-Item -ItemType Directory -Path $dlRoot -Force | Out-Null
    Write-Host ' [0/6] 正在下载插件源码...' -ForegroundColor Cyan
    try {
        Invoke-WebRequest -Uri 'https://codeload.github.com/Feiyuwan09/dsh-auto-workspace/zip/refs/heads/main' -OutFile $zipPath
        Expand-Archive -Path $zipPath -DestinationPath $dlRoot -Force
    } catch {
        Fail "下载源码失败：$($_.Exception.Message)"
    }
    $srcDir = Join-Path $dlRoot 'dsh-auto-workspace-main'
    if (-not (Test-Path (Join-Path $srcDir 'package.json'))) { Fail '下载/解压失败，请手动下载仓库后运行本地 install.bat' }
}
$srcDir = [IO.Path]::GetFullPath($srcDir)

Write-Host ""
Write-Host ' ============================================================' -ForegroundColor Yellow
Write-Host '   dsh-auto-workspace 一键安装' -ForegroundColor Yellow
Write-Host ' ============================================================' -ForegroundColor Yellow
Write-Host ""

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }

# ---------- 1/6. 定位 profile ----------
$profilesRoot = Join-Path $dshHome 'profiles'
$profileDir = $null
if ($ProfileArg) {
    if (Test-Path (Join-Path $ProfileArg 'package.json')) {
        $profileDir = [IO.Path]::GetFullPath($ProfileArg)
    } elseif (Test-Path (Join-Path $profilesRoot (Join-Path $ProfileArg 'package.json'))) {
        $profileDir = Join-Path $profilesRoot $ProfileArg
    }
} else {
    $found = @()
    if (Test-Path $profilesRoot) {
        $found = @(Get-ChildItem $profilesRoot -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'package.json') })
    }
    if ($found.Count -eq 1) {
        $profileDir = $found[0].FullName
    } elseif ($found.Count -eq 0) {
        Fail "在 $profilesRoot 下没有找到 profile；请显式指定：install.ps1 <profile 名或目录>"
    } else {
        Fail "在 $profilesRoot 下找到 $($found.Count) 个 profile，无法自动确定；请显式指定：install.ps1 <profile 名或目录>"
    }
}
if (-not $profileDir -or -not (Test-Path (Join-Path $profileDir 'package.json'))) {
    Fail "没有找到 profile：$ProfileArg"
}
Step "[1/6] 目标 profile：$profileDir"

# ---------- 2/6. 备份 package.json ----------
$ts = Get-Date -Format 'yyyyMMdd_HHmmss'
$backup = Join-Path $profileDir "package.json.bak-auto-workspace-$ts"
Copy-Item (Join-Path $profileDir 'package.json') $backup
Step "[2/6] 已备份 package.json -> $backup"

# ---------- 3/6. 拷贝插件到 plugins 目录 ----------
$pluginDir = Join-Path $dshHome 'plugins\dsh-auto-workspace'
$srcFull = [IO.Path]::GetFullPath($srcDir).TrimEnd('\')
$pluginFull = [IO.Path]::GetFullPath($pluginDir).TrimEnd('\')
if ($srcFull -ieq $pluginFull) {
    Step '[3/6] 源码目录即插件目录，跳过拷贝'
} else {
    if (Test-Path $pluginDir) {
        $oldBackup = "$pluginDir.bak-$ts"
        Move-Item $pluginDir $oldBackup
        Write-Host "        旧插件目录已备份 -> $oldBackup" -ForegroundColor DarkGray
    }
    New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
    Copy-Item -Path (Join-Path $srcDir '*') -Destination $pluginDir -Recurse -Force
    Remove-Item (Join-Path $pluginDir '.git') -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $pluginDir 'copyexclude.txt') -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path (Join-Path $pluginDir 'lib\index.mjs'))) {
        Fail "插件拷贝失败，请手动把 $srcDir 复制到 $pluginDir"
    }
    Step "[3/6] 已拷贝插件 -> $pluginDir"
}

# ---------- 4/6. 注册到 profile package.json ----------
Step '[4/6] 检查 profile 的 package.json...'
$pkgPath = Join-Path $profileDir 'package.json'
$content = [IO.File]::ReadAllText($pkgPath)
if ($content -match 'dsh-auto-workspace') {
    Write-Host '        已注册过 dsh-auto-workspace，跳过修改' -ForegroundColor DarkGray
} else {
    # 依赖声明：标准布局下用相对路径，profile 在别处时用绝对路径
    $inProfiles = $profileDir.StartsWith($profilesRoot + '\', [StringComparison]::OrdinalIgnoreCase)
    $depSpec = if ($inProfiles) { 'file:../../plugins/dsh-auto-workspace' } else { 'file:' + ($pluginDir -replace '\\', '/') }
    # dependencies：空对象 / 已有内容 分别处理
    if ($content -match '"dependencies"\s*:\s*\{\s*\}') {
        $content = $content -replace '"dependencies"\s*:\s*\{\s*\}', "`"dependencies`": {`r`n    `"dsh-auto-workspace`": `"$depSpec`"`r`n  }"
    } elseif ($content -match '"dependencies"\s*:\s*\{') {
        $content = $content -replace '("dependencies"\s*:\s*\{)', "`$1`r`n    `"dsh-auto-workspace`": `"$depSpec`","
    } else {
        Fail 'package.json 里没有找到 dependencies 区块，请手动添加依赖'
    }
    # bundles：空数组 / 已有内容 分别处理
    if ($content -match '"bundles"\s*:\s*\[\s*\]') {
        $content = $content -replace '"bundles"\s*:\s*\[\s*\]', "`"bundles`": [`r`n        `"dsh-auto-workspace`"`r`n      ]"
    } elseif ($content -match '"bundles"\s*:\s*\[') {
        $content = $content -replace '("bundles"\s*:\s*\[)', "`$1`r`n        `"dsh-auto-workspace`","
    } else {
        Fail 'package.json 里没有找到 dsh.profile.bundles 区块，请手动把 dsh-auto-workspace 加入 bundles'
    }
    [IO.File]::WriteAllText($pkgPath, $content)
    Write-Host '        package.json 已更新' -ForegroundColor DarkGray
}

# ---------- 5/6. 安装依赖 ----------
Step '[5/6] 安装依赖（把插件链接进 profile）...'
Push-Location $profileDir
try {
    $installCmd = $null
    if (Get-Command pnpm -ErrorAction SilentlyContinue) { $installCmd = { & pnpm install } }
    elseif (Get-Command corepack -ErrorAction SilentlyContinue) { $installCmd = { & corepack pnpm install } }
    elseif (Get-Command npm -ErrorAction SilentlyContinue) { $installCmd = { & npm install } }
    else { Fail '没有找到 pnpm / corepack / npm，请先安装 Node.js 或 pnpm' }
    & $installCmd
    if ($LASTEXITCODE -ne 0) { Fail "依赖安装失败（exit $LASTEXITCODE）。备份已保留：$backup" }
} finally {
    Pop-Location
}
if (-not (Test-Path (Join-Path $profileDir 'node_modules\dsh-auto-workspace\lib\index.mjs'))) {
    Write-Host ' [警告] node_modules 里没有出现 dsh-auto-workspace，重启 Harness 前请确认' -ForegroundColor Yellow
}

# ---------- 6/6. 完成 ----------
Write-Host ""
Write-Host ' [6/6] 安装完成！' -ForegroundColor Green
Write-Host ''
Write-Host '  下一步：重启 DeepSeek Harness 使插件生效。' -ForegroundColor Yellow
Write-Host '  之后新建分区将不再弹目录选择框，默认创建 default-workspace[-N]，'
Write-Host '  可在 插件管理页 -> dsh-auto-workspace -> 配置 里修改目录名前缀。'
Write-Host ''
Write-Host "  备份文件：$backup" -ForegroundColor DarkGray
Write-Host "  插件目录：$pluginDir" -ForegroundColor DarkGray
Write-Host ''
