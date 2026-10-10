/**
 * dsh-whale-meme / payloads —— 从 `texts/` 逐字抽取投喂负载（`build`）。
 *
 * 为什么插件里要重做一遍（而不是只调工作区那份脚本）：
 * `_tools/build_payloads.py` 的任务路径是**写死的字面量**（`TASK = ...task01...`），
 * 换任务就得改脚本，而脚本是工作区自己的资产、插件不该改。这里改由清单里的
 * `extraction` 计划驱动：换任务只改清单，脚本一个字节都不动。
 *
 * 逐字保真的口径与 `build_payloads.py` 完全一致（这是可机器验证的）：
 *   * 从 markdown 代码围栏里按序号取正文；
 *   * 只做换行归一化（CRLF → LF），正文一字不改；
 *   * 结尾保证恰好一个换行；
 *   * sha256 对**磁盘上的实际字节**取 —— 与出图元数据里的 `prompt.sha256` 同口径。
 *
 * @module dsh-whale-meme/payloads
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { normalizeText, readText } from './core.mjs'
import { codeFences, deriveExtractionPlan, findTask, taskFilePath } from './manifest.mjs'

/** 与 build_payloads.py 一致的写盘口径：UTF-8 无 BOM、LF、结尾一个换行。 */
function payloadBytes(body) {
  const normalized = normalizeText(body)
  const withNewline = normalized.endsWith('\n') ? normalized : `${normalized}\n`
  return Buffer.from(withNewline, 'utf8')
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * 按抽取计划生成负载（默认只规划，不落盘）。
 *
 * @param {object} input
 * @param {string} input.root - 工作区根目录
 * @param {string} input.task - 任务号
 * @param {string} input.taskDirName - 任务目录名
 * @param {object} input.manifest - 工作区清单
 * @param {boolean} [input.write] - 是否落盘；缺省 false（dry-run）
 * @returns {object} 结果含每份负载的来源、字符数、sha256 与断言结果
 */
export function buildPayloads(input) {
  const { root, task, taskDirName, manifest } = input
  const write = input.write === true
  const { plan, reason } = deriveExtractionPlan(manifest, task)
  const errors = []
  const warnings = []

  if (!plan || !Array.isArray(plan.payloads) || plan.payloads.length === 0) {
    return {
      ok: false,
      dryRun: !write,
      wrote: false,
      task,
      errors: [
        reason ?? `清单里没有 ${task} 的 extraction 计划`,
        `请先在 .whale/manifest.json 里为该任务补一段 extraction 计划，形如：`,
        `  { "id": "${task}", "extraction": { "payloads": [ { "file": "10_母图_中性站姿.txt", "from": "02_提示词_GPT-Image-2.5.md", "block": 2, "source": "02_…§3 第0步（逐字）", "assert": "中性站姿全身母图" } ] } }`,
      ],
      entries: [],
    }
  }

  const known = findTask(manifest, task)
  const dirName = taskDirName ?? known?.dirName
  if (!dirName) errors.push(`无法确定 ${task} 的目录名（清单里没有 dirName，且调用方也没给）`)

  const outDir = path.join(root, '_tools', 'payloads', task)
  const entries = []
  const fenceCache = new Map()

  for (const item of plan.payloads ?? []) {
    const fileName = item.file
    const from = item.from
    const blockIndex = Number(item.block)
    const entry = { file: fileName, from, block: blockIndex, source: item.source ?? null, status: 'pending' }

    if (!fileName || !from || !Number.isInteger(blockIndex) || blockIndex < 0) {
      entry.status = 'bad-plan'
      errors.push(`抽取计划里这一条不合法（需要 file / from / 非负整数 block）：${JSON.stringify(item)}`)
      entries.push(entry)
      continue
    }

    const fromPath = taskFilePath(root, dirName, from)
    if (!existsSync(fromPath)) {
      entry.status = 'missing-source'
      errors.push(`来源文件不存在：${fromPath}`)
      entries.push(entry)
      continue
    }

    let fences = fenceCache.get(fromPath)
    if (!fences) {
      fences = codeFences(readText(fromPath))
      fenceCache.set(fromPath, fences)
    }
    const fence = fences[blockIndex]
    if (!fence) {
      entry.status = 'block-out-of-range'
      errors.push(`${from} 只有 ${fences.length} 个代码块，取不到第 ${blockIndex} 块（序号从 0 开始）`)
      entries.push(entry)
      continue
    }
    if (item.assert && !fence.body.includes(item.assert)) {
      entry.status = 'assert-failed'
      errors.push(`${from} 第 ${blockIndex} 块里找不到断言短语「${item.assert}」—— 索引很可能错位了，拒绝抽取`)
      entries.push(entry)
      continue
    }

    const bytes = payloadBytes(fence.body)
    const actual = existsSync(path.join(outDir, fileName)) ? sha256Buffer(readFileSync(path.join(outDir, fileName))) : null
    const sha = sha256Buffer(bytes)
    entry.bytes = bytes.length
    entry.chars = bytes.toString('utf8').length
    entry.lines = bytes.toString('utf8').split('\n').length
    entry.sha256 = sha
    entry.previousSha256 = actual
    entry.changed = actual !== null && actual !== sha
    entry.sameAsDisk = actual === sha
    entry.status = 'ok'
    entry._bytes = bytes
    entries.push(entry)
  }

  const okToWrite = errors.length === 0
  const changedCount = entries.filter(entry => entry.status === 'ok' && entry.sameAsDisk === false).length

  if (!write) {
    return {
      ok: okToWrite,
      dryRun: true,
      wrote: false,
      task,
      outDir,
      entries: entries.map(({ _bytes, ...rest }) => rest),
      errors,
      warnings,
      wouldWrite: changedCount,
    }
  }
  if (!okToWrite) {
    return {
      ok: false,
      dryRun: false,
      wrote: false,
      task,
      outDir,
      entries: entries.map(({ _bytes, ...rest }) => rest),
      errors,
      warnings,
      note: '有抽取错误，为免产出错位负载，一个文件都没写。',
    }
  }

  mkdirSync(outDir, { recursive: true })
  const written = []
  for (const entry of entries) {
    const target = path.join(outDir, entry.file)
    writeFileSync(target, entry._bytes)
    const onDisk = readFileSync(target)
    const onDiskSha = sha256Buffer(onDisk)
    written.push({ file: entry.file, sha256: onDiskSha, bytes: onDisk.length, shaMatches: onDiskSha === entry.sha256 })
  }

  const index = {
    generated_by: 'dsh-whale-meme (whale_meme build)',
    workspace: root,
    source_dir: path.join(root, 'texts', dirName),
    payloads: entries.map(({ _bytes, ...rest }) => ({
      file: rest.file,
      chars: rest.chars,
      lines: rest.lines,
      bytes: rest.bytes,
      sha256: rest.sha256,
      source: rest.source,
      first_line: '',
    })),
  }
  // first_line 便于人工核对，和 build_payloads.py 的索引保持同样的字段
  for (const item of index.payloads) {
    const body = readText(path.join(outDir, item.file))
    item.first_line = body.split('\n')[0].slice(0, 60)
  }
  writeFileSync(path.join(outDir, '_payload_index.json'), Buffer.from(`${JSON.stringify(index, null, 2)}\n`, 'utf8'))

  return {
    ok: written.every(item => item.shaMatches),
    dryRun: false,
    wrote: true,
    task,
    outDir,
    entries: entries.map(({ _bytes, ...rest }) => rest),
    written,
    errors,
    warnings,
    indexFile: path.join(outDir, '_payload_index.json'),
  }
}
