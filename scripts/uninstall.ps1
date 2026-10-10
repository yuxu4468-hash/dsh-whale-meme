<#
.SYNOPSIS
  从 DSH 的 desktop profile 卸载 dsh-whale-meme。

.DESCRIPTION
  优先恢复安装时留下的备份（package.json.bak-whale-meme-*）：
    * 有备份 → 清单直接恢复成安装前的样子（最干净）。
    * 无备份 → 调 patch-profile.mjs 精确摘掉 dependencies 与 dsh.profile.bundles 里的条目。
  两种方式都会删除 profile node_modules 下指向本插件的 Junction（只删联接，不删目标目录）。
  不会删除插件源码，也不会动工作区里任何文件。

.PARAMETER PluginDir
  插件目录，默认取本脚本所在目录的上一级。

.PARAMETER Profile
  DSH profile 名，默认 desktop。

.PARAMETER KeepJunction
  只清清单，保留 node_modules 里的联接。
#>
[CmdletBinding()]
param(
  [string]$PluginDir = '',
  [string]$Profile = 'desktop',
  [switch]$KeepJunction
)

$ErrorActionPreference = 'Stop'
$PackageName = 'dsh-whale-meme'

# 默认插件目录 = 本脚本所在目录（scripts/）的上一级。
# 不用 $MyInvocation.MyCommand.Path：param 默认值求值时它是 null。
if ([string]::IsNullOrWhiteSpace($PluginDir)) {
  $PluginDir = Split-Path -Parent $PSScriptRoot
}

function Write-Step([string]$Text) { Write-Host "`n== $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "   [ok] $Text" -ForegroundColor Green }
function Write-Warn2([string]$Text) { Write-Host "   [!]  $Text" -ForegroundColor Yellow }
function Write-Fail([string]$Text) { Write-Host "   [x]  $Text" -ForegroundColor Red }

$PluginDir = (Resolve-Path -LiteralPath $PluginDir).Path
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome "profiles\$Profile"
$manifestPath = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { Write-Fail "找不到 profile 清单：$manifestPath"; exit 2 }

if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) {
  Write-Warn2 'DSH Desktop 正在运行：卸载会在下次完全重启后生效。'
}

Write-Step '处理 profile 清单'
$backups = @(Get-ChildItem -LiteralPath $profileDir -Filter 'package.json.bak-whale-meme-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
if ($backups.Count -gt 0) {
  $latest = $backups[0]
  Copy-Item -LiteralPath $latest.FullName -Destination $manifestPath -Force
  Write-Ok "已恢复安装前备份：$($latest.Name)"
  if ($backups.Count -gt 1) { Write-Warn2 "另有 $($backups.Count - 1) 个较旧备份保留未动，可人工清理。" }
} else {
  Write-Warn2 '没找到安装备份，改为精确摘条目。'
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { Write-Fail '需要 node.exe 才能安全改写清单'; exit 2 }
  & $node (Join-Path $PluginDir 'scripts\patch-profile.mjs') --profile-dir $profileDir --action remove --package $PackageName
  if ($LASTEXITCODE -ne 0) { Write-Fail "清单改写失败（退出码 $LASTEXITCODE）"; exit 3 }
}

Write-Step '处理 node_modules 联接'
$linkPath = Join-Path $profileDir "node_modules\$PackageName"
if (-not (Test-Path -LiteralPath $linkPath)) {
  Write-Ok '没有联接需要处理'
} elseif ($KeepJunction) {
  Write-Ok "已保留：$linkPath"
} else {
  $item = Get-Item -LiteralPath $linkPath -Force
  if ($item.LinkType -eq 'Junction') {
    [IO.Directory]::Delete($linkPath, $false)
    Write-Ok "已删除联接：$linkPath（插件源码目录未动）"
  } else {
    Write-Warn2 "$linkPath 不是 Junction，未自动删除，请人工确认。"
  }
}

Write-Host "`n完成。请完全退出并重启 DSH Desktop 使卸载生效。" -ForegroundColor Cyan
Write-Host "插件源码仍在：$PluginDir（要彻底清除请手动删除该目录）"
