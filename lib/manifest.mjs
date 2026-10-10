/**
 * dsh-whale-meme / manifest —— 工作区清单（`.whale/manifest.json`）。
 *
 * 清单只记录**可从磁盘重建的事实**（目录树、任务、负载抽取计划），不存内容副本、不存凭据。
 * 它的价值有两个：
 *   1. 让 `init` 能创建缺失的目录与文件，而不覆盖已有内容；
 *   2. 让 `build` 能在**不依赖工作区里那份手改脚本**的前提下重建投喂负载 ——
 *      `_tools/build_payloads.py` 的任务路径是写死的字面量，换任务就得改脚本，清单解决这个问题。
 *
 * @module dsh-whale-meme/manifest
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { MANIFEST_RELATIVE, TASK_FILES, normalizeText, readText } from './core.mjs'

export { MANIFEST_RELATIVE }

/** 清单结构版本。改动结构时递增，便于将来迁移。 */
export const MANIFEST_VERSION = 1

/** init 会创建的目录（相对工作区根）。 */
export const WORKSPACE_DIRS = Object.freeze([
  'datas/01_character',
  'datas/02_reference_stickers',
  'texts',
  'outs',
  '_tools/payloads',
  '.whale',
])

/** 缺失时 init 会创建的空占位文件（已存在则一字不改）。 */
export const WORKSPACE_FILES = Object.freeze({
  'outs/INDEX.csv': 'path,model,role,size,bytes,sha256_16,note\n',
  'datas/02_reference_stickers/README.md': '# 参考语料\n\n放社区同人表情包截图，仅作风格/题材/构图参考，**不得当作成品交付**。\n',
})

/** 工作区顶部说明；只在缺失时创建。 */
function workspaceReadme() {
  return [
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
}

/** 默认的「清单不存在时」的工作区骨架。 */
function defaultManifest(root) {
  return {
    schemaVersion: MANIFEST_VERSION,
    generatedBy: 'dsh-whale-meme',
    root,
    tasks: [],
  }
}

/** 读取清单；不存在或损坏时返回默认骨架并给出提示。 */
export function loadManifest(root) {
  const file = path.join(root, MANIFEST_RELATIVE)
  if (!existsSync(file)) return { file, exists: false, manifest: defaultManifest(root), warnings: [] }
  try {
    const parsed = JSON.parse(readText(file))
    if (!parsed || typeof parsed !== 'object') throw new Error('清单不是对象')
    if (!Array.isArray(parsed.tasks)) parsed.tasks = []
    return { file, exists: true, manifest: parsed, warnings: [] }
  } catch (error) {
    return {
      file,
      exists: true,
      manifest: defaultManifest(root),
      warnings: [`清单无法解析（${error.message}），已按空清单处理；不会覆盖原文件，除非你显式 init 并确认。`],
    }
  }
}

/** 写清单（UTF-8 无 BOM，LF，2 空格缩进）。 */
export function saveManifest(root, manifest) {
  const file = path.join(root, MANIFEST_RELATIVE)
  mkdirSync(path.dirname(file), { recursive: true })
  const body = `${JSON.stringify({ ...manifest, schemaVersion: MANIFEST_VERSION }, null, 2)}\n`
  writeFileSync(file, Buffer.from(body, 'utf8'))
  return file
}

/** 取某个任务在清单里的记录。 */
export function findTask(manifest, taskId) {
  return (manifest.tasks ?? []).find(entry => entry.id === taskId) ?? null
}

/** 写入/更新一个任务的记录（合并，不丢已有字段）。 */
export function upsertTask(manifest, taskId, patch) {
  const tasks = Array.isArray(manifest.tasks) ? [...manifest.tasks] : []
  const index = tasks.findIndex(entry => entry.id === taskId)
  if (index >= 0) tasks[index] = { ...tasks[index], ...patch, id: taskId }
  else tasks.push({ id: taskId, ...patch })
  return { ...manifest, tasks }
}

/**
 * 为某个任务推导缺省抽取计划（当清单里没有显式计划时使用）。
 *
 * 这里刻意**不做猜测**：块序号、来源说明文件、断言短语都必须由调用方给出，
 * 否则宁可不抽取。因为「抽错负载」的代价是一次付费出图，
 * 而 `build_payloads.py` 当初正是靠断言避免索引错位。
 */
export function deriveExtractionPlan(manifest, taskId) {
  const record = findTask(manifest, taskId)
  if (!record?.extraction) return { plan: null, reason: `清单里没有 ${taskId} 的 extraction 计划` }
  return { plan: record.extraction, reason: null }
}

/**
 * 从提示词文件的 markdown 代码围栏里按序号取一段正文（逐字）。
 * 与 `_tools/build_payloads.py` 的正则一致：```lang\n<正文>\n```
 */
export function codeFences(markdown) {
  return [...normalizeText(markdown).matchAll(/```(\w*)\n([\s\S]*?)\n```/g)]
    .map(match => ({ lang: match[1] || '', body: match[2] }))
}

/** 任务目录下某个文件位的绝对路径。 */
export function taskFilePath(root, taskDirName, fileName) {
  return path.join(root, 'texts', taskDirName, fileName)
}

/** 任务目录下五件套的存在情况。 */
export function taskFileStatus(root, taskDirName) {
  return Object.entries(TASK_FILES).map(([key, fileName]) => {
    const abs = taskFilePath(root, taskDirName, fileName)
    return { key, fileName, path: abs, exists: existsSync(abs) }
  })
}
