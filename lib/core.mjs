/**
 * dsh-whale-meme / core —— 「蓝色大肥鱼表情包」工作流的纯逻辑层。
 *
 * 本模块是平台无关的：只依赖 node: 内置模块，不 import 任何 DSH 包，
 * 因此可以脱离宿主用 `node --test` 直接跑真实工作区数据。
 * 宿主接线（工具注册、技能注册、契约注入）全部在 ./index.mjs 里。
 *
 * 工作流契约（本模块负责校验的部分）：
 *   datas/  角色与参考资料（只读基准）
 *   texts/  成品提示词（提示词阶段唯一可写）
 *   _tools/payloads/<task>/  投喂负载（由 texts/ 逐字抽取，禁止手打）
 *   outs/   出图产物 + 每次调用的元数据
 *
 * @module dsh-whale-meme/core
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

export const MANIFEST_RELATIVE = path.join('.whale', 'manifest.json')

/** 工作流阶段定义；id 同时用作工具 action 的取值。 */
export const STAGES = Object.freeze([
  { id: 'research', label: '资料基准', dir: 'datas', writeOwner: '资料搜寻阶段' },
  { id: 'prompt', label: '提示词', dir: 'texts', writeOwner: '提示词阶段' },
  { id: 'payload', label: '投喂负载', dir: '_tools/payloads', writeOwner: '出图阶段（由 texts/ 逐字抽取）' },
  { id: 'render', label: '出图产物', dir: 'outs', writeOwner: '出图阶段' },
])

/** 角色剪影三要素：任何提示词与产物都不得丢失。 */
export const SILHOUETTE_ANCHORS = Object.freeze([
  '头侧两片鲸鳍状耳',
  '身后完整大体量双叉鲸尾',
  '深蓝→浅蓝渐变长发＋头顶偏左卷曲呆毛',
])

/** 每个任务目录的固定文件位（缺失即视为该阶段未完成）。 */
export const TASK_FILES = Object.freeze({
  storyboard: '00_分镜与文案锁定.md',
  promptImage2: '01_提示词_GPT-Image-2.md',
  promptImage25: '02_提示词_GPT-Image-2.5.md',
  textFallback: '03_无字底图与后期排版兜底.md',
  acceptance: '04_验收清单.md',
})

/** 出图产物的推荐交付件命名（模型目录内）。 */
export const DELIVERABLE_PATTERN = /^05_整图一次出图.*\.png$/

/** 出图档位与透明底支持（本项目实测口径，2026-10-10）。 */
export const MODEL_PROFILES = Object.freeze({
  'gpt-image-2': {
    id: 'gpt-image-2',
    label: 'GPT Image 2',
    endpointGeneration: 'POST /v1/images/generations',
    endpointEdit: 'POST /v1/images/edits',
    qualities: ['low', 'medium', 'high'],
    defaultQuality: 'high',
    transparentBackground: false,
    notes: '不支持透明底：出浅灰白平涂底，透明与白描边留到后期抠图。',
  },
  'gpt-image-2.5-sunburst': {
    id: 'gpt-image-2.5-sunburst',
    label: 'GPT Image 2.5 · Sunburst',
    endpointGeneration: 'POST /v1/images/generations',
    endpointEdit: 'POST /v1/images/edits',
    qualities: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultQuality: 'xhigh',
    transparentBackground: true,
    notes: '支持 background: transparent 真透明 PNG；多轮编辑不跑偏，定稿首选。',
  },
  'gpt-image-2.5-flare': {
    id: 'gpt-image-2.5-flare',
    label: 'GPT Image 2.5 · Flare',
    endpointGeneration: 'POST /v1/images/generations',
    endpointEdit: 'POST /v1/images/edits',
    qualities: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultQuality: 'high',
    transparentBackground: true,
    notes: '速度优先的小模型，用于草稿；定稿请换 Sunburst。',
  },
})

/** 调用前的环境约束（全部来自本机实测）。 */
export const ENVIRONMENT_RULES = Object.freeze([
  '图像模型不能当子代理的 LLM：/chat/completions 会被网关拒绝（「该模型是图像生成模型」），只能由文本代理驱动脚本调用。',
  '返回的是约 30 分钟过期的签名 URL，必须立即下载。',
  '下载必须带浏览器 User-Agent，否则 Cloudflare 403 error code: 1010。',
  'JSON 端点的 n 必须是整数；multipart 端点可以传字符串。',
  '在 pwsh 里不要内联中文：一切提示词文本走 --prompt-file。',
  'edit 端点要在 --image 里传参考图；立绘是成熟比例，编辑链第 0 步必须先压成 2~3 头身 Q 版母图。',
])

// ─────────────────────────────── 小工具 ───────────────────────────────

/** @returns {string} 去掉 BOM 并统一为 \n 换行的文本。 */
export function normalizeText(text) {
  return String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

/** @returns {string} 文本的 sha256 十六进制小写。 */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** @returns {string} 磁盘文件的 sha256 十六进制小写（按字节，不做换行归一化）。 */
export function sha256File(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex')
}

/** @returns {string} 中文可读的字节数。 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/** 存在性判断（不抛错）。 */
export function existsSyncSafe(target) {
  try {
    return existsSync(target)
  } catch {
    return false
  }
}

/** 读取文本文件，失败时抛带路径的错误。 */
export function readText(absPath) {
  try {
    return normalizeText(readFileSync(absPath, 'utf8'))
  } catch (error) {
    throw new Error(`读取失败：${absPath}（${error.code ?? error.message}）`)
  }
}

// ─────────────────────────── 工作区定位 ───────────────────────────

/**
 * 判断一个目录是否像一个「蓝色大肥鱼」工作区。
 * 判据刻意宽松但要求至少两条硬特征，避免把任意目录误判成工作区。
 * @returns {{ok: boolean, hits: string[]}}
 */
export function looksLikeWhaleWorkspace(dir) {
  const hits = []
  const checks = [
    ['_tools/whale_image_client.py', 'file'],
    ['_tools/payloads', 'dir'],
    ['datas/01_character', 'dir'],
    ['texts/README.md', 'file'],
    ['outs/INDEX.csv', 'file'],
    ['outs/README.md', 'file'],
  ]
  for (const [relative, kind] of checks) {
    const target = path.join(dir, relative)
    try {
      const stat = statSync(target)
      if (kind === 'dir' ? stat.isDirectory() : stat.isFile()) hits.push(relative)
    } catch {
      // 不存在就跳过
    }
  }
  return { ok: hits.length >= 2, hits }
}

/**
 * 定位工作区根目录。
 * 顺序：显式 root → 环境变量 DSH_WHALE_ROOT → 从 startDir 逐级向上探测 → DSH cwd。
 * @param {{root?: string|null, startDir?: string, env?: Record<string, string|undefined>}} [options]
 * @returns {{root: string, how: string, evidence: string[]}}
 */
export function resolveWorkspaceRoot(options = {}) {
  const env = options.env ?? process.env
  if (options.root) {
    const explicit = path.resolve(options.root)
    if (!existsSync(explicit)) throw new Error(`配置的工作区根目录不存在：${explicit}`)
    return { root: explicit, how: 'config', evidence: looksLikeWhaleWorkspace(explicit).hits }
  }
  if (env.DSH_WHALE_ROOT) {
    const fromEnv = path.resolve(env.DSH_WHALE_ROOT)
    if (existsSync(fromEnv)) return { root: fromEnv, how: 'env:DSH_WHALE_ROOT', evidence: looksLikeWhaleWorkspace(fromEnv).hits }
  }
  const start = path.resolve(options.startDir ?? env.DSH_CWD ?? process.cwd())
  let cursor = start
  for (;;) {
    const probe = looksLikeWhaleWorkspace(cursor)
    if (probe.ok) return { root: cursor, how: `walk-up from ${start}`, evidence: probe.hits }
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  throw new Error(
    `没有找到「蓝色大肥鱼」工作区：从 ${start} 逐级向上都没命中判据（需要 _tools/whale_image_client.py、`
    + `datas/01_character、texts/README.md、outs/INDEX.csv 中至少两项）。`
    + `请设置 DSH_WHALE_ROOT 或插件配置 root。`,
  )
}

// ─────────────────────────── 任务发现 ───────────────────────────

/**
 * 列出工作区里的任务：以 texts/ 下的 taskNN_* 目录为准，附带 outs/ 下的产物目录。
 * @returns {Array<{id: string, number: number, slug: string, title: string, textsDir: string|null, outsDir: string|null}>}
 */
export function listTasks(root) {
  const textsRoot = path.join(root, 'texts')
  const outsRoot = path.join(root, 'outs')
  const ids = new Set()
  const seen = new Map()

  const collect = (base) => {
    if (!existsSync(base)) return
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const match = /^task(\d+)_?(.*)$/.exec(entry.name)
      if (!match) continue
      const key = `task${match[1]}`
      ids.add(key)
      const record = seen.get(key) ?? { id: key, number: Number(match[1]), slug: '', textsDir: null, outsDir: null, titles: new Set() }
      record.titles.add(match[2])
      if (!record.slug) record.slug = match[2]
      if (base === textsRoot) record.textsDir = path.join(base, entry.name)
      if (base === outsRoot) record.outsDir = path.join(base, entry.name)
      seen.set(key, record)
    }
  }
  collect(textsRoot)
  collect(outsRoot)

  return [...seen.values()]
    .map(record => ({
      id: record.id,
      number: record.number,
      slug: record.slug,
      title: `${record.id}_${record.slug}`,
      textsDir: record.textsDir,
      outsDir: record.outsDir,
    }))
    .sort((a, b) => a.number - b.number)
}

/** 匹配用户给的 task 选择器（task01 / 01 / task01_xxx）。 */
export function matchTask(tasks, selector) {
  if (!selector) return tasks.length === 1 ? tasks[0] : null
  const raw = String(selector).trim()
  const digits = /(\d+)/.exec(raw)
  if (!digits) return null
  const number = Number(digits[1])
  return tasks.find(task => task.number === number) ?? null
}

// ─────────────────────────── 负载索引 ───────────────────────────

/** 读取 `_tools/payloads/<task>/_payload_index.json`。 */
export function readPayloadIndex(root, task) {
  const dir = path.join(root, '_tools', 'payloads', task)
  const indexFile = path.join(dir, '_payload_index.json')
  if (!existsSync(indexFile)) return { dir, indexFile, exists: false, payloads: [] }
  const parsed = JSON.parse(readText(indexFile))
  const payloads = (parsed.payloads ?? []).map(entry => ({
    file: entry.file,
    absPath: path.join(dir, entry.file),
    chars: entry.chars ?? null,
    bytes: entry.bytes ?? null,
    sha256: entry.sha256 ?? null,
    source: entry.source ?? null,
  }))
  return { dir, indexFile, exists: true, payloads }
}

/** 核验负载索引里每份负载的实际字节 sha256 是否与索引一致。 */
export function verifyPayloadIndex(root, task) {
  const { dir, indexFile, exists, payloads } = readPayloadIndex(root, task)
  if (!exists) {
    return { task, dir, indexFile, exists: false, ok: false, entries: [], reason: '缺少 _payload_index.json' }
  }
  const entries = payloads.map(entry => {
    if (!existsSync(entry.absPath)) {
      return { ...entry, actualSha256: null, actualBytes: null, recorded: entry.sha256, status: 'missing' }
    }
    const actualSha256 = sha256File(entry.absPath)
    const actualBytes = statSync(entry.absPath).size
    const matchesRecord = entry.sha256 === null || entry.sha256 === actualSha256
    const matchesText = entry.source === null || sourceFileContains(root, entry.source, readText(entry.absPath))
    return {
      ...entry,
      actualSha256,
      actualBytes,
      matchesRecord,
      matchesTextSource: matchesText,
      status: !matchesRecord ? 'payload-drift' : (matchesText ? 'ok' : 'source-drift'),
    }
  })
  return {
    task,
    dir,
    indexFile,
    exists: true,
    ok: entries.every(entry => entry.status === 'ok') && entries.length > 0,
    entries,
    reason: entries.length === 0 ? '索引为空' : undefined,
  }
}

/**
 * 判断负载文本是否仍逐字出现在它声称的来源文件里（忽略行尾空白与换行）。
 * 这是「投喂文本没有被手打改写」的机器证据。
 */
export function sourceFileContains(root, sourceLabel, payloadText) {
  const candidate = resolveSourceLabel(root, sourceLabel)
  if (!candidate) return false
  const haystack = stripFences(candidate)
  return haystack.includes(trimEdges(payloadText))
}

/** 从「02_提示词_GPT-Image-2.5.md §3 第0步（逐字）」这类标签里找出源文件绝对路径。 */
export function resolveSourceLabel(root, sourceLabel) {
  if (!sourceLabel) return null
  // 文件名里含点（GPT-Image-2.5.md）与短横，必须从标签开头吃到 .md，
  // 不能用一个会把第一个「.」当分界的字符类（那样只会匹配到 _GPT-Image-2.5.md）。
  const match = /^\s*([^\s]+\.md)/.exec(sourceLabel) ?? /([0-9A-Za-z_\-.]*\.md)/.exec(sourceLabel)
  if (!match) return null
  const fileName = match[1]
  const textsRoot = path.join(root, 'texts')
  if (!existsSync(textsRoot)) return null
  for (const dir of readdirSync(textsRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const candidate = path.join(textsRoot, dir.name, fileName)
    if (existsSync(candidate)) return readText(candidate)
  }
  return null
}

/** 去掉 markdown 代码围栏，保留围栏内正文（用于「逐字出现在源文件里」的宽松比对）。 */
export function stripFences(markdown) {
  return normalizeText(markdown).replace(/^```[^\n]*\n?/gm, '').replace(/^```\s*$/gm, '')
}

/** 去掉首尾空行与行尾空白，便于跨 markdown 结构的逐字比对。 */
export function trimEdges(text) {
  return normalizeText(text)
    .split('\n')
    .map(line => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
}

// ─────────────────── 分镜与文案（唯一权威文本） ───────────────────

/**
 * 解析 `00_分镜与文案锁定.md` 的「逐字文案」小节。
 *
 * 该小节的约定：一个 ```text 围栏，内部用「格 N（…）」「第 N 行」这类标记行分隔文案，
 * 括号里可以写加粗要求（例如「（仅「整篇损坏」四个字加粗）」）。
 * 只读不写：这里只做结构化核对单，绝不复述或改写文案。
 *
 * @returns {{storyboardFile: string, exists: boolean, ok: boolean, lines: Array<{marker: string|null, text: string, notes: string[], index: number}>, boldHints: string[], warnings: string[]}}
 */
export function parseStoryboard(root, task) {
  const found = findTextsDir(root, task)
  if (!found) {
    return { storyboardFile: null, exists: false, ok: false, lines: [], boldHints: [], warnings: ['找不到 texts/taskNN_* 目录'] }
  }
  const file = path.join(found, TASK_FILES.storyboard)
  if (!existsSync(file)) {
    return { storyboardFile: file, exists: false, ok: false, lines: [], boldHints: [], warnings: [`缺少 ${TASK_FILES.storyboard}`] }
  }
  const markdown = readText(file)
  const warnings = []

  // 1) 在「## N. 逐字文案」小节里找第一个 ```text 围栏。
  const sectionMatch = /^##\s*\d*\.?\s*逐字文案[^\n]*\n([\s\S]*?)(?=^##\s|\Z)/m.exec(markdown)
  const section = sectionMatch?.[1] ?? markdown
  if (!sectionMatch) warnings.push('没有找到「逐字文案」小节，已退化为全文搜索')
  const fence = /```(?:text)?\n([\s\S]*?)\n```/.exec(section)
  if (!fence) {
    return { storyboardFile: file, exists: true, ok: false, lines: [], boldHints: [], warnings: [...warnings, '「逐字文案」小节里没有代码围栏'] }
  }

  // 2) 逐行拆：marker 行只做标记，其余非空行是文案本体。
  const lines = []
  const boldHints = []
  for (const raw of fence[1].split('\n')) {
    const text = raw.trim()
    if (text === '') continue
    const marker = /^(格\s*\d+（[^）]*）|格\s*\d+|第\s*\d+\s*行|全句)$/.exec(text)
    const notes = [...text.matchAll(/[（(]([^）)]*加粗[^）)]*)[）)]/g)].map(match => match[1].trim())
    for (const note of notes) {
      for (const quoted of note.matchAll(/[「『]([^」』]+)[」』]/g)) boldHints.push(quoted[1])
    }
    // 整行只是一条括号说明（例如「（仅「整篇损坏」四个字加粗）」）时，它不是文案本体，
    // 但它的内容已经作为加粗线索收进 boldHints。
    const noteOnly = /^[（(][^）)]*[）)]$/.test(text)
    if (noteOnly || marker) continue
    lines.push({ marker: null, text, notes, index: lines.length })
  }

  // 3) 把 marker 行归属到它后面的文案上（便于人读与核对）。
  const markers = fence[1].split('\n').map(line => line.trim()).filter(line => /^(格\s*\d+|第\s*\d+\s*行)/.test(line))
  lines.forEach((line, position) => {
    line.marker = markers[position] ?? null
  })

  if (lines.length === 0) warnings.push('「逐字文案」围栏里没有解析到文案行')
  for (const line of lines) {
    if (!/[。！？!?]$/.test(line.text)) warnings.push(`文案第 ${line.index + 1} 行没有以句末标点结尾：${line.text}`)
    if (/[a-zA-Z0-9]/.test(line.text)) warnings.push(`文案第 ${line.index + 1} 行含半角字符，请人工确认：${line.text}`)
  }
  return { storyboardFile: file, exists: true, ok: lines.length > 0, lines, boldHints: [...new Set(boldHints)], warnings }
}

/** 找出该任务的 texts/taskNN_* 目录。 */
export function findTextsDir(root, task) {
  const tasks = listTasks(root)
  const hit = matchTask(tasks, task)
  return hit?.textsDir ?? null
}

// ─────────────────────────── 出图产物审计 ───────────────────────────

const IMAGE_EXTENSIONS = new Set(['.png', '.webp', '.jpg', '.jpeg'])

/** PNG 头解析：宽高与颜色类型（不引入图像库）。 */
export function readPngHeader(absPath) {
  let buffer
  try {
    buffer = readFileSync(absPath)
  } catch {
    return null
  }
  if (buffer.length < 33 || buffer.readUInt32BE(0) !== 0x89504e47) return null
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  const bitDepth = buffer[24]
  const colorType = buffer[25]
  const colorNames = { 0: 'gray', 2: 'rgb', 3: 'palette', 4: 'gray+alpha', 6: 'rgba' }
  return {
    width,
    height,
    bitDepth,
    colorType,
    colorTypeName: colorNames[colorType] ?? `unknown(${colorType})`,
    hasAlphaChannel: colorType === 4 || colorType === 6,
  }
}

/** 汇总一个模型目录的产物：图片、元数据、覆盖情况。 */
export function auditModelDir(modelDir) {
  if (!existsSync(modelDir)) return null
  // 先建元数据索引，再扫图片：否则「PNG 排在 JSON 之前」时同名 .json 还没进索引，
  // 会误报 no-metadata（英文下划线开头的文件名正是排在数字之前）。
  const entries = readdirSync(modelDir, { withFileTypes: true })
  const jsonFiles = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name)
  const metaCache = new Map()
  const readMeta = (name) => {
    if (metaCache.has(name)) return metaCache.get(name)
    let value = null
    try {
      value = JSON.parse(readText(path.join(modelDir, name)))
    } catch {
      value = { parseError: true }
    }
    metaCache.set(name, value)
    return value
  }

  const images = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
    const abs = path.join(modelDir, entry.name)
    const size = statSync(abs).size
    const header = path.extname(entry.name).toLowerCase() === '.png' ? readPngHeader(abs) : null
    // whale_image_client.py 写元数据的口径是「去掉图片扩展名 + .json」
    // （01_母图_中性站姿_1024.png → 01_母图_中性站姿_1024.json）；
    // 同时容忍 <png 全名>.json 的写法。
    const baseName = entry.name.replace(/\.[^.]+$/, '')
    const metaName = [baseName, entry.name]
      .map(name => `${name}.json`)
      .find(name => jsonFiles.includes(name)) ?? null
    const meta = metaName ? readMeta(metaName) : null
    images.push({
      file: entry.name,
      absPath: abs,
      bytes: size,
      size: header ? `${header.width}x${header.height}` : null,
      hasAlphaChannel: header?.hasAlphaChannel ?? null,
      deprecate: entry.name.startsWith('_弃用'),
      deliverable: DELIVERABLE_PATTERN.test(entry.name),
      metaFile: metaName,
      metaSha256: meta?.prompt?.sha256 ?? meta?.prompt_sha256 ?? null,
      metaModel: meta?.model ?? meta?.request?.model ?? null,
      metaRequestSize: meta?.request?.size ?? meta?.response?.size ?? null,
      metaQuality: meta?.request?.quality_echoed_by_api ?? meta?.request?.quality ?? meta?.response?.quality ?? null,
      metaBackground: meta?.request?.background_echoed_by_api ?? meta?.response?.background ?? null,
      metaParseError: meta?.parseError === true,
    })
  }
  images.sort((a, b) => a.file.localeCompare(b.file, 'zh-Hans-CN'))
  const ACCEPTED_SIZES = new Set(['1024x1024', '1024x1536', '1024x2072'])
  const warnings = images
    .filter(image => !image.deprecate && image.size && !ACCEPTED_SIZES.has(image.size))
    .map(image => `${image.file} 尺寸 ${image.size} 不在本项目常用档（1024x1024 单格 / 1024x1536 整图 / 1024x2072 拼合）`)
  warnings.push(...images.filter(image => image.size === null && !image.deprecate).map(image => `${image.file} 不是可解析的 PNG`))
  warnings.push(...images.filter(image => image.metaParseError).map(image => `${image.metaFile} 不是合法 JSON`))
  warnings.push(...images.filter(image => !image.metaFile && !image.deprecate).map(image => `${image.file} 缺少同名 .json 元数据`))
  return {
    dir: modelDir,
    images,
    jsonFiles,
    deliverables: images.filter(image => image.deliverable),
    warnings,
    checkFile: existsSync(path.join(modelDir, 'checks.json')) ? path.join(modelDir, 'checks.json') : null,
    reportFile: existsSync(path.join(modelDir, 'run_report.md')) ? path.join(modelDir, 'run_report.md') : null,
  }
}

/** 审计整个 outs/<task>/ 目录。 */
export function auditOuts(root, task) {
  const tasks = listTasks(root)
  const hit = matchTask(tasks, task)
  if (!hit) return { task, exists: false, outsDir: null, models: [], acceptanceFile: null, warnings: ['没有匹配到任务'] }
  const outsDir = hit.outsDir
  if (!outsDir) return { task: hit.id, exists: false, outsDir: null, models: [], acceptanceFile: null, warnings: [`outs/ 下没有 ${hit.id}_* 目录`] }
  const models = []
  for (const entry of readdirSync(outsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const audited = auditModelDir(path.join(outsDir, entry.name))
    if (audited) models.push({ model: entry.name, ...audited })
  }
  const acceptance = readdirSync(outsDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /验收/.test(entry.name))
    .map(entry => path.join(outsDir, entry.name))
  const warnings = []
  if (models.length === 0) warnings.push('outs/ 下没有模型子目录')
  if (acceptance.length === 0) warnings.push('缺少 _验收记录.md')
  for (const model of models) {
    if (model.deliverables.length === 0) warnings.push(`${model.model} 没有 05_整图一次出图*.png 推荐交付件`)
    if (!model.checkFile) warnings.push(`${model.model} 缺少 checks.json`)
  }
  return { task: hit.id, exists: true, outsDir, models, acceptanceFile: acceptance[0] ?? null, warnings }
}

// ─────────────────────────── 元数据对齐 ───────────────────────────

/**
 * 把每个产物的 prompt.sha256 与负载索引对齐 —— 证明「投喂文本没有被改写」。
 */
export function verifyPromptLineage(root, task) {
  const index = readPayloadIndex(root, task)
  const bySha = new Map(index.payloads.filter(entry => entry.sha256).map(entry => [entry.sha256, entry.file]))
  const outs = auditOuts(root, task)
  const rows = []
  for (const model of outs.models ?? []) {
    for (const image of model.images) {
      if (image.deprecate) continue
      if (!image.metaSha256) {
        rows.push({ model: model.model, image: image.file, promptSha256: null, payload: null, status: 'no-metadata' })
        continue
      }
      const payload = bySha.get(String(image.metaSha256).toLowerCase()) ?? null
      rows.push({
        model: model.model,
        image: image.file,
        promptSha256: String(image.metaSha256),
        payload,
        status: payload ? 'ok' : 'unknown-prompt',
      })
    }
  }
  const metadataMissing = rows.filter(row => row.status === 'no-metadata')
  const unknown = rows.filter(row => row.status === 'unknown-prompt')
  const unaligned = [...metadataMissing, ...unknown]
  return {
    task: outs.task ?? task,
    indexExists: index.exists,
    payloadCount: index.payloads.length,
    rows,
    // ok 的判据是「没有任何一张产物对不上负载索引」。
    // 缺元数据本身不算对不上：本地拼合产物（compose_panels.py）根本不写元数据，
    // 那是正常现象，单列成 warnings 由调用方判断。
    ok: rows.length > 0 && unknown.length === 0,
    unknown: unknown.length,
    missing: metadataMissing.length,
    unaligned: unaligned.map(row => `${row.model}/${row.image}`),
    warnings: metadataMissing.map(row => `${row.model}/${row.image} 没有元数据（如果是本地拼合产物则属正常）`),
  }
}

// ─────────────────────────── 清单（.whale/manifest.json） ───────────────────────────

/** 读取工作区清单；不存在时返回 null。 */
export function readManifest(root) {
  const file = path.join(root, MANIFEST_RELATIVE)
  if (!existsSync(file)) return { file, exists: false, manifest: null }
  return { file, exists: true, manifest: JSON.parse(readText(file)) }
}

/** 工作流契约文本（注入上下文用）。 */
export function buildContract(root, options = {}) {
  const lines = []
  lines.push('# 「蓝色大肥鱼」表情包工作区 · 工作流契约')
  lines.push('')
  lines.push(`工作区根目录：${root}`)
  lines.push('')
  lines.push('## 阶段与归属（谁写哪里）')
  for (const stage of STAGES) lines.push(`- \`${stage.dir}/\` — ${stage.label}：${stage.writeOwner}`)
  lines.push('')
  lines.push('## 角色剪影三要素（任何提示词与产物都不得丢失）')
  for (const anchor of SILHOUETTE_ANCHORS) lines.push(`- ${anchor}`)
  lines.push('')
  lines.push('## 硬规则')
  lines.push('- 文案以 `texts/<task>/00_分镜与文案锁定.md` 的逐字表为唯一权威，出图阶段不得即兴改写。')
  lines.push('- 投喂文本一律由脚本从 `texts/` 逐字抽取到 `_tools/payloads/<task>/`，出图用 `--prompt-file`，禁止手打或 `--prompt-text`。')
  lines.push('- 参考语料 `datas/02_reference_stickers/` 只作风格/题材参考，不得当成品交付。')
  lines.push('- 署名入口：角色原作 上善无形；女仆鲸鱼娘二次设计 ZipZipPipe；非商业 CC BY-NC-SA 4.0，不得出现「官方」措辞。')
  lines.push('')
  lines.push(`工作流细节与命令见技能 \`${options.skillName ?? 'whale-meme-workflow'}\`；机械校验用工具 \`whale_meme\`。`)
  const text = lines.join('\n')
  const max = options.maxChars ?? 6000
  return text.length > max ? `${text.slice(0, max)}\n…（契约已截断，完整内容见技能与 _tools/）` : text
}
