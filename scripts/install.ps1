<#
.SYNOPSIS
  把 dsh-whale-meme 插件装进 DSH 的 desktop profile（可回滚）。

.DESCRIPTION
  步骤：
    1. 预检插件完整性与 profile 存在性。
    2. 备份 profile 的 package.json（带时间戳）。
    3. 调 patch-profile.mjs（Node）改 dependencies 与 dsh.profile.bundles。
       —— 不用 PowerShell 改 JSON：PowerShell 5.1 会把中文转义成 \uXXXX，
          还可能写进 UTF-8 BOM（本机历史上 BOM 曾导致 DSH 启动失败）。
    4. 在 profile 的 node_modules 下为插件目录建 Junction。
    5. 调 patch-profile.mjs 复核；任何一步失败都自动回滚清单。

  本脚本不联网、不调用 pnpm、不改插件源码、不改工作区里任何文件、不重启应用。

.PARAMETER PluginDir
  插件目录，默认取本脚本所在目录的上一级。

.PARAMETER Profile
  DSH profile 名，默认 desktop。

.PARAMETER DryRun
  只打印将要做的改动，不落盘。
#>
[CmdletBinding()]
param(
  [string]$PluginDir = '',
  [string]$Profile = 'desktop',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$PackageName = 'dsh-whale-meme'

# 默认插件目录 = 本脚本所在目录（scripts/）的上一级。
# 不用 $MyInvocation.MyCommand.Path：在 param 默认值里它是 null（param 绑定早于脚本体求值）。
if ([string]::IsNullOrWhiteSpace($PluginDir)) {
  $PluginDir = Split-Path -Parent $PSScriptRoot
}

function Write-Step([string]$Text) { Write-Host "`n== $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "   [ok] $Text" -ForegroundColor Green }
function Write-Warn2([string]$Text) { Write-Host "   [!]  $Text" -ForegroundColor Yellow }
function Write-Fail([string]$Text) { Write-Host "   [x]  $Text" -ForegroundColor Red }

Write-Step '预检'
if (-not (Test-Path -LiteralPath $PluginDir)) { Write-Fail "插件目录不存在：$PluginDir"; exit 2 }
$PluginDir = (Resolve-Path -LiteralPath $PluginDir).Path
foreach ($required in @('package.json', 'cordis.patch.yml', 'lib\index.mjs', 'assets\skill\whale-meme-workflow\SKILL.md')) {
  if (-not (Test-Path -LiteralPath (Join-Path $PluginDir $required))) { Write-Fail "插件不完整，缺少 $required"; exit 2 }
}
$pluginName = (Get-Content -LiteralPath (Join-Path $PluginDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).name
if ($pluginName -ne $PackageName) { Write-Fail "插件 name 应为 $PackageName，实际 $pluginName"; exit 2 }
Write-Ok "插件：$PackageName @ $PluginDir"

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Fail '系统 PATH 里找不到 node.exe —— 本脚本用 Node 安全地改 profile 清单，请先确保 node 可用'; exit 2 }
Write-Ok "node：$node"

$patchScript = Join-Path $PluginDir 'scripts\patch-profile.mjs'
if (-not (Test-Path -LiteralPath $patchScript)) { Write-Fail "缺少 $patchScript"; exit 2 }

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome "profiles\$Profile"
$manifestPath = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { Write-Fail "找不到 profile 清单：$manifestPath"; exit 2 }
Write-Ok "profile：$profileDir"

if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) {
  Write-Warn2 '检测到 DSH Desktop 正在运行。改动会立即落盘，但必须「完全退出托盘 → 重新打开」才生效。'
}

Write-Step '备份清单'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = Join-Path $profileDir "package.json.bak-whale-meme-$stamp"
if ($DryRun) { Write-Ok "（dry-run）将备份到 $backupPath" }
else { Copy-Item -LiteralPath $manifestPath -Destination $backupPath -Force; Write-Ok "备份：$backupPath" }

Write-Step '修改 profile 清单（Node 精确改写，保持缩进与换行）'
if ($DryRun) {
  Write-Ok "（dry-run）将执行：node patch-profile.mjs --action add --package $PackageName --target `"$PluginDir`""
} else {
  & $node $patchScript --profile-dir $profileDir --action add --package $PackageName --target $PluginDir
  if ($LASTEXITCODE -ne 0) {
    Write-Fail "清单改写失败（退出码 $LASTEXITCODE）—— 正在恢复备份"
    Copy-Item -LiteralPath $backupPath -Destination $manifestPath -Force
    exit 3
  }
}

Write-Step '建立 node_modules 联接'
$nodeModules = Join-Path $profileDir 'node_modules'
if (-not (Test-Path -LiteralPath $nodeModules)) {
  Write-Fail "profile 没有 node_modules：$nodeModules（先用 DSH 终端装过任意插件即可生成）"
  if (-not $DryRun) { Copy-Item -LiteralPath $backupPath -Destination $manifestPath -Force; Write-Warn2 '已回滚清单' }
  exit 2
}
$linkPath = Join-Path $nodeModules $PackageName
if (Test-Path -LiteralPath $linkPath) {
  $item = Get-Item -LiteralPath $linkPath -Force
  if ($item.LinkType -eq 'Junction' -and (@($item.Target) -contains $PluginDir)) {
    Write-Ok "联接已存在：$linkPath"
  } else {
    Write-Fail "$linkPath 已存在且不是指向本插件的联接，请人工确认后再装"
    if (-not $DryRun) { Copy-Item -LiteralPath $backupPath -Destination $manifestPath -Force; Write-Warn2 '已回滚清单' }
    exit 3
  }
} elseif ($DryRun) {
  Write-Ok "（dry-run）将建立 Junction：$linkPath → $PluginDir"
} else {
  New-Item -ItemType Junction -Path $linkPath -Target $PluginDir | Out-Null
  Write-Ok "已建立 Junction：$linkPath → $PluginDir"
}

Write-Step '复核'
if ($DryRun) {
  Write-Ok '（dry-run）跳过复核'
} else {
  & $node $patchScript --profile-dir $profileDir --action verify --package $PackageName --target $PluginDir
  if ($LASTEXITCODE -ne 0) {
    Write-Fail '复核失败 —— 正在回滚'
    Copy-Item -LiteralPath $backupPath -Destination $manifestPath -Force
    if (Test-Path -LiteralPath $linkPath) {
      $item = Get-Item -LiteralPath $linkPath -Force
      if ($item.LinkType -eq 'Junction') { [IO.Directory]::Delete($linkPath, $false) }
    }
    exit 4
  }
}

Write-Host "`n================ 下一步 ================" -ForegroundColor Cyan
Write-Host ' 请【完全退出】DSH Desktop（托盘右键 → 退出；关窗口只是隐藏），然后重新打开。'
Write-Host ' 重启后两句验证：'
Write-Host '   1) 问「这个工作区怎么工作」—— 应命中 whale-meme-workflow 技能'
Write-Host '   2) 调用 whale_meme(action="status") —— 应返回工作区全景'
Write-Host ''
Write-Host " 回滚：powershell -NoProfile -File `"$PluginDir\scripts\uninstall.ps1`""
if (-not $DryRun) { Write-Host " 备份：$backupPath" }
