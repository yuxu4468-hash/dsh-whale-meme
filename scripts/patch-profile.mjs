/**
 * patch-profile.mjs —— 精确修改 DSH profile 的 package.json（供 install/uninstall.ps1 调用）。
 *
 * 为什么不让 PowerShell 干这件事：
 *   1. Windows PowerShell 5.1 的 ConvertTo-Json 会把非 ASCII 字符转义成 \uXXXX，
 *      把本来中文可读的插件清单搞成不可读（语义等价但难以人工核对）。
 *   2. 本机 profile 清单历史上曾被写入 UTF-8 BOM，导致 DSH 启动时 JSON 解析失败、应用打不开。
 *      这里读写都不带 BOM，并且回车换行、键顺序、两空格缩进全部保持原样。
 *
 * 用法：
 *   node patch-profile.mjs --profile-dir <dir> --action add   --package dsh-whale-meme --target "<插件目录>"
 *   node patch-profile.mjs --profile-dir <dir> --action remove --package dsh-whale-meme
 *   node patch-profile.mjs --profile-dir <dir> --action verify --package dsh-whale-meme --target "<插件目录>"
 *
 * 退出码：0 成功（或无需改动）；2 用法/前置错误；3 校验失败。
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    out[token.slice(2)] = argv[index + 1]?.startsWith('--') === false ? argv[++index] : true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const profileDir = args['profile-dir']
const action = args.action
const packageName = args.package
const target = args.target

if (!profileDir || !action || !packageName) {
  console.error('用法：node patch-profile.mjs --profile-dir <dir> --action add|remove|verify --package <name> [--target <dir>]')
  process.exit(2)
}

const manifestPath = path.join(profileDir, 'package.json')
if (!existsSync(manifestPath)) {
  console.error(`找不到 profile 清单：${manifestPath}`)
  process.exit(2)
}

/** 读取清单原文；返回 { text, bom, eol, data }。 */
function readManifest() {
  const bytes = readFileSync(manifestPath)
  let text = bytes.toString('utf8')
  const bom = text.charCodeAt(0) === 0xfeff
  if (bom) text = text.slice(1)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    console.error(`profile 清单不是合法 JSON：${error.message}`)
    process.exit(2)
  }
  return { text, bom, eol, data }
}

/** 在与原文相同的缩进/EOL/尾换行风格下写回，且绝不带 BOM。 */
function writeManifest(data, { eol, text }) {
  const indent = /^\s+"[^"]+":/m.exec(text)?.[0]?.match(/^\s+/)?.[0] ?? '  '
  const trailingNewline = text.endsWith('\n')
  const json = JSON.stringify(data, null, indent).split('\n').join(eol) + (trailingNewline ? '' : '')
  writeFileSync(manifestPath, Buffer.from(json, 'utf8'))
  const check = readFileSync(manifestPath)
  if (check[0] === 0xef && check[1] === 0xbb && check[2] === 0xbf) {
    throw new Error('写回结果带 BOM，已中止')
  }
}

const { text, eol, data } = readManifest()

if (action === 'verify') {
  const problems = []
  const dep = data.dependencies?.[packageName]
  if (!dep) problems.push(`dependencies 缺 ${packageName}`)
  else if (target && dep !== `link:${target}`) problems.push(`dependencies 的 ${packageName} 指向 ${dep}，期望 link:${target}`)
  if (!Array.isArray(data.dsh?.profile?.bundles)) problems.push('缺少 dsh.profile.bundles')
  else if (!data.dsh.profile.bundles.includes(packageName)) problems.push(`dsh.profile.bundles 缺 ${packageName}`)
  const entry = path.join(profileDir, 'node_modules', packageName, 'lib', 'index.mjs')
  if (!existsSync(entry)) problems.push(`node_modules 解析不到插件入口：${entry}`)
  else {
    try {
      const pluginPkg = JSON.parse(readFileSync(path.join(profileDir, 'node_modules', packageName, 'package.json'), 'utf8'))
      const patchRel = pluginPkg.dsh?.bundle?.patch
      if (!patchRel) problems.push('插件 package.json 没有 dsh.bundle.patch')
      else {
        const patchPath = path.join(profileDir, 'node_modules', packageName, patchRel.replace(/^\.\//, ''))
        if (!existsSync(patchPath)) problems.push(`bundle 补丁文件不存在：${patchPath}`)
      }
    } catch (error) {
      problems.push(`读插件 package.json 失败：${error.message}`)
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  [x] ${problem}`)
    process.exit(3)
  }
  console.log('校验通过：清单合法、dependencies/bundles 齐全、插件入口与 bundle 补丁均可解析')
  process.exit(0)
}

let changed = 0
if (action === 'add') {
  if (!data.dependencies) {
    console.error('profile 清单没有 dependencies 段，拒绝改写')
    process.exit(2)
  }
  const linkSpec = `link:${target}`
  if (data.dependencies[packageName] === linkSpec) {
    console.log(`  [ok] dependencies 已存在且正确：${packageName} = ${linkSpec}`)
  } else {
    if (data.dependencies[packageName]) console.log(`  [!] dependencies 已存在，覆盖为 ${linkSpec}（原：${data.dependencies[packageName]}）`)
    else console.log(`  [ok] dependencies 新增：${packageName} = ${linkSpec}`)
    data.dependencies[packageName] = linkSpec
    changed += 1
  }
  if (!Array.isArray(data.dsh?.profile?.bundles)) {
    console.error('profile 清单没有 dsh.profile.bundles，拒绝改写')
    process.exit(2)
  }
  if (data.dsh.profile.bundles.includes(packageName)) {
    console.log(`  [ok] dsh.profile.bundles 已存在：${packageName}`)
  } else {
    data.dsh.profile.bundles.push(packageName)
    changed += 1
    console.log(`  [ok] dsh.profile.bundles 追加：${packageName}（现共 ${data.dsh.profile.bundles.length} 项）`)
  }
} else if (action === 'remove') {
  if (data.dependencies?.[packageName]) {
    delete data.dependencies[packageName]
    changed += 1
    console.log(`  [ok] dependencies 移除：${packageName}`)
  } else {
    console.log('  [ok] dependencies 里本来就没有该条目')
  }
  if (Array.isArray(data.dsh?.profile?.bundles) && data.dsh.profile.bundles.includes(packageName)) {
    data.dsh.profile.bundles = data.dsh.profile.bundles.filter(entry => entry !== packageName)
    changed += 1
    console.log(`  [ok] dsh.profile.bundles 移除：${packageName}（现共 ${data.dsh.profile.bundles.length} 项）`)
  } else {
    console.log('  [ok] dsh.profile.bundles 里本来就没有该条目')
  }
} else {
  console.error(`未知 action：${action}`)
  process.exit(2)
}

if (changed === 0) {
  console.log('  无需改动')
  process.exit(0)
}

try {
  writeManifest(data, { eol, text })
} catch (error) {
  console.error(`  [x] 写回失败：${error.message}`)
  process.exit(3)
}
console.log(`  [ok] 已写回 ${manifestPath}（UTF-8 无 BOM，保持原缩进与换行）`)
console.log(`  [ok] 文件大小 ${statSync(manifestPath).size} 字节`)
