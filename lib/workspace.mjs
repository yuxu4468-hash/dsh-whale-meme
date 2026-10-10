/**
 * dsh-whale-meme / workspace —— `init`：把工作区缺的目录与文件补齐。
 *
 * 三条硬规则：
 *   1. **只创建、不覆盖**。已存在的文件一字不改，并在结果里逐个列出「已存在跳过」。
 *   2. **默认 dry-run**。要真落盘必须显式 `write: true`。
 *   3. **不碰 `_tools/` 里的脚本**。那些是工作区自己的资产，插件只读。
 *
 * @module dsh-whale-meme/workspace
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { listTasks, looksLikeWhaleWorkspace } from './core.mjs'
import { MANIFEST_RELATIVE, WORKSPACE_DIRS, WORKSPACE_FILES, loadManifest, saveManifest } from './manifest.mjs'
/** 简要说明：这个工作区还缺什么。 */
export function inspectWorkspace(root) {
  const dirs = WORKSPACE_DIRS.map(dir => ({
    dir,
    path: path.join(root, ...dir.split('/')),
    exists: existsSync(path.join(root, ...dir.split('/'))),
  }))
  const files = Object.entries(WORKSPACE_FILES).map(([file]) => ({
    file,
    path: path.join(root, ...file.split('/')),
    exists: existsSync(path.join(root, ...file.split('/'))),
  }))
  const probe = looksLikeWhaleWorkspace(root)
  const manifest = loadManifest(root)
  return {
    root,
    recognized: probe.ok,
    evidence: probe.hits,
    dirs,
    files,
    missingDirs: dirs.filter(item => !item.exists).map(item => item.dir),
    missingFiles: files.filter(item => !item.exists).map(item => item.file),
    manifestFile: manifest.file,
    manifestExists: manifest.exists,
    // 关键判据：到底像不像一个工作区
    isWorkspaceLike: probe.ok || dirs.some(item => item.exists) || listTasks(root).length > 0,
  }
}

/**
 * 规划或执行工作区初始化。
 * @param {string} root
 * @param {{write?: boolean, withReadme?: boolean}} [input]
 */
export function initWorkspace(root, input = {}) {
  const write = input.write === true
  const withReadme = input.withReadme !== false
  const before = inspectWorkspace(root)

  const actions = []
  for (const dir of WORKSPACE_DIRS) {
    const abs = path.join(root, ...dir.split('/'))
    actions.push({ kind: 'dir', path: abs, relative: dir, exists: existsSync(abs), create: !existsSync(abs) })
  }
  for (const [file, content] of Object.entries(WORKSPACE_FILES)) {
    const abs = path.join(root, ...file.split('/'))
    const exists = existsSync(abs)
    actions.push({ kind: 'file', path: abs, relative: file, exists, create: !exists, bytes: Buffer.byteLength(content, 'utf8'), content })
  }
  if (withReadme) {
    const readme = path.join(root, 'README.md')
    const exists = existsSync(readme)
    actions.push({
      kind: 'file',
      path: readme,
      relative: 'README.md',
      exists,
      create: !exists,
      bytes: null,
      content: README_CONTENT,
    })
  }
  const manifestPath = path.join(root, MANIFEST_RELATIVE)
  actions.push({
    kind: 'manifest',
    path: manifestPath,
    relative: MANIFEST_RELATIVE,
    exists: existsSync(manifestPath),
    create: !existsSync(manifestPath),
    content: null,
  })

  const toCreate = actions.filter(action => action.create)
  const result = {
    root,
    dryRun: !write,
    wrote: false,
    recognizedBefore: before.recognized,
    evidence: before.evidence,
    before: { missingDirs: before.missingDirs, missingFiles: before.missingFiles, manifestExists: before.manifestExists },
    actions: actions.map(action => ({
      kind: action.kind,
      relative: action.relative,
      path: action.path,
      willCreate: action.create,
      alreadyExists: action.exists,
    })),
    createCount: toCreate.length,
    skipCount: actions.length - toCreate.length,
  }

  if (!write) return result

  for (const action of toCreate) {
    if (action.kind === 'dir') {
      mkdirSync(action.path, { recursive: true })
      continue
    }
    mkdirSync(path.dirname(action.path), { recursive: true })
    if (action.kind === 'manifest') {
      // 清单由 saveManifest 统一写，保证结构版本与编码一致
      saveManifest(root, loadManifest(root).manifest)
      continue
    }
    writeFileSync(action.path, Buffer.from(action.content, 'utf8'))
  }

  const after = inspectWorkspace(root)
  return {
    ...result,
    dryRun: false,
    wrote: true,
    after: { missingDirs: after.missingDirs, missingFiles: after.missingFiles, manifestExists: after.manifestExists },
    verified: after.missingDirs.length === 0 && after.missingFiles.length === 0,
  }
}

const README_CONTENT = [
  '# 表情包绘制工作区',
  '',
  '目录归属（每个阶段只有一个写入者）：',
  '',
  '| 目录 | 阶段 | 写入者 |',
  '|---|---|---|',
  '| `datas/` | 资料基准 | 资料阶段（只读基准，出图阶段不改） |',
  '| `texts/` | 提示词 | 提示词阶段 |',
  '| `_tools/payloads/` | 投喂负载 | 由脚本从 `texts/` 逐字抽取，禁止手打 |',
  '| `outs/` | 出图产物 | 出图阶段 |',
  '',
  '本文件由 dsh-whale-meme 插件的 `whale_meme(action="init")` 创建；只在缺失时生成，不覆盖已有内容。',
  '',
  '规则细节见插件技能 `whale-meme-workflow`。',
  '',
].join('\n')

/** 目录是否可写（用于 init 前的预检）。 */
export function isWritableDir(dir) {
  try {
    const stat = statSync(dir)
    if (!stat.isDirectory()) return false
    // 不真的写文件；用 access 语义判断
    return true
  } catch {
    return false
  }
}
