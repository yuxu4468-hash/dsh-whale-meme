/**
 * dsh-whale-meme / fetch —— 从上游开源仓库拉取「蓝色大肥鱼」参考素材。
 *
 * 上游是 **EDMOK/blue-fish-archive**（公开仓库，本工作区 `datas/` 的语料全部来自它，
 * 见 `datas/05_sources/SOURCES.md`）。这里通过 GitHub REST API 按需下载，
 * **不依赖 git**（本机到 github.com:443 的 git 传输不通，API 域名正常），也不引入第三方包。
 *
 * 三条硬规则：
 *   1. **默认 dry-run**：先出计划（文件数、体积、落点），`write: true` 才真下载；
 *   2. **只往 datas/ 写**，不触碰 texts/ 与 outs/，也不改 `_tools/` 里的脚本；
 *   3. **记来源**：每次下载写一份 `SOURCE.json`，含仓库、commit、许可与逐文件清单 ——
 *      上游明确是 CC BY-NC-SA 4.0（署名—非商业—相同方式共享），必须留下可追溯的记录。
 *
 * @module dsh-whale-meme/fetch
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { createHash } from 'node:crypto'

/** 上游仓库。 */
export const UPSTREAM = Object.freeze({
  owner: 'EDMOK',
  repo: 'blue-fish-archive',
  slug: 'EDMOK/blue-fish-archive',
  license: 'CC BY-NC-SA 4.0',
  note: '非官方同人档案馆；使用时须保留署名、非商业、相同方式共享。',
})

/**
 * 可下载的素材包。
 * `dest` 是相对工作区的落点；`match` 在上游文件树里挑文件；`exclude` 过滤噪音。
 *
 * 挑得刻意保守：上游是**站点仓库**，除了素材还带字体、favicon、二维码、音频、
 * 以及网页本体（html/js/css）。那些对出图毫无用处，只会把工作区搞乱。
 */
export const BUNDLES = Object.freeze({
  character: {
    id: 'character',
    label: '角色基准（立绘 + 官方 logo）',
    why: '出图前锁角色身份用；立绘是编辑链第 0 步的输入。',
    dest: 'datas/01_character',
    match: ['assets/deepseek_whale.png', 'assets/deepseek_whale.webp', '原始立绘/', 'logo/deepseek_zh'],
    exclude: ['favicon', 'apple-touch-icon', 'fonts/'],
  },
  samples: {
    id: 'samples',
    label: '表情包样例与图库清单',
    why: '看题材与排版惯例；manifest.json 是 251 张语料的清单（含宽高）。',
    dest: 'datas/02_reference_stickers',
    match: ['memes/', 'stickers/'],
    exclude: ['.aac', '.mp3', '.json.bak'],
  },
  previews: {
    id: 'previews',
    label: '社区同人语料缩略图（251 张 webp，约 12.5 MB）',
    why: '风格与题材参考。**只作参考，不得作为成品交付**；著作权归各自创作者。',
    dest: 'datas/02_reference_stickers/previews',
    match: ['previews/'],
    big: true,
  },
  large: {
    id: 'large',
    label: '语料大图（251 张，约 33.7 MB）',
    why: '需要看清细节时才下；只看风格用 previews 就够。',
    dest: 'datas/02_reference_stickers/large',
    match: ['large/'],
    big: true,
  },
  media: {
    id: 'media',
    label: '语料原图（251 张，约 242 MB）',
    why: '体积很大，通常不需要；除非要做像素级比对。',
    dest: 'datas/02_reference_stickers/media',
    match: ['media/'],
    huge: true,
  },
})

/** 只下载图片：上游还带字体、音频与网页，那些不属于「参考图」。 */
const IMAGE_EXTENSIONS = ['.png', '.webp', '.jpg', '.jpeg', '.gif', '.json']

/** 默认下载组合：够开始干活，又不至于一次拉几百兆。 */
export const DEFAULT_BUNDLES = ['character', 'samples', 'previews']

/** 人读大小。 */
function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 解析 bundles 参数：接受数组、逗号分隔字符串，或 all。 */
export function resolveBundles(input) {
  if (input === undefined || input === null || input === '') {
    return { ids: [...DEFAULT_BUNDLES], errors: [] }
  }
  const raw = Array.isArray(input) ? input : String(input).split(/[,，\s]+/)
  const cleaned = raw.map(item => String(item).trim()).filter(Boolean)
  if (cleaned.some(item => item === 'all')) return { ids: Object.keys(BUNDLES), errors: [] }
  const unknown = cleaned.filter(item => !BUNDLES[item])
  if (unknown.length > 0) {
    return { ids: [], errors: [`未知素材包：${unknown.join('、')}；可用：${Object.keys(BUNDLES).join(', ')} 或 all`] }
  }
  return { ids: cleaned, errors: [] }
}

/**
 * 按上游文件树挑出每个素材包要下载的文件（纯函数，便于测试）。
 * @param {Array<{path: string, size: number, type: string}>} tree - 上游 git tree
 * @param {string[]} bundleIds
 * @returns {{selected: Array<object>, perBundle: Array<object>, totalBytes: number}}
 */
export function planDownloads(tree, bundleIds) {
  const blobs = tree.filter(node => node.type === 'blob')
  const selected = []
  const perBundle = []
  const skipped = []

  for (const id of bundleIds) {
    const bundle = BUNDLES[id]
    const candidates = blobs.filter(node =>
      bundle.match.some(pattern => (pattern.endsWith('/') ? node.path.startsWith(pattern) : node.path === pattern)))
    const matched = candidates.filter(node => {
      if ((bundle.exclude ?? []).some(pattern => node.path.includes(pattern))) { skipped.push(node.path); return false }
      if (!IMAGE_EXTENSIONS.includes(path.extname(node.path).toLowerCase())) { skipped.push(node.path); return false }
      return true
    })
    // 落点：剥掉与 dest 对应的那一层，保留其余结构，避免同名文件互相覆盖
    const files = matched.map(node => {
      const relative = mapRelativePath(node.path, bundle)
      return {
        bundle: id,
        fromPath: node.path,
        toRelative: relative,
        toPath: path.join(bundle.dest, relative),
        size: node.size ?? 0,
      }
    })
    perBundle.push({
      id,
      label: bundle.label,
      dest: bundle.dest,
      count: files.length,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
      bytesHuman: humanBytes(files.reduce((sum, file) => sum + file.size, 0)),
      huge: bundle.huge === true,
      skipped: candidates.length - files.length,
      note: bundle.why,
    })
    selected.push(...files)
  }

  return {
    selected,
    perBundle,
    skipped,
    totalBytes: selected.reduce((sum, file) => sum + file.size, 0),
  }
}

/**
 * 上游路径 → 落点相对路径。
 *
 * 规则：**剥掉与 dest 语义重复的那一层目录前缀，其余结构保留**。
 * 保留结构的理由：`assets/deepseek_whale.png` 与 `原始立绘/deepseek_whale.png` 同名，
 * 拍平会互相覆盖，而且看不出文件来自上游哪个位置。
 */
function mapRelativePath(upstreamPath, bundle) {
  const destTail = bundle.dest.split('/').pop()
  const prefixes = [...bundle.match.filter(pattern => pattern.endsWith('/')), `${destTail}/`]
  for (const prefix of prefixes) {
    if (upstreamPath.startsWith(prefix)) return upstreamPath.slice(prefix.length)
  }
  // 单文件匹配（例如 assets/deepseek_whale.png）：保留其上游目录名，避免同名冲突
  const parts = upstreamPath.split('/')
  return parts.length === 1 ? upstreamPath : parts.slice(-2).join('/')
}

/** 去掉匹配前缀，得到落地相对路径（保留给需要拍平的调用方）。 */
function stripPrefix(fromPath, patterns) {
  for (const pattern of patterns) {
    if (pattern.endsWith('/') && fromPath.startsWith(pattern)) return fromPath.slice(pattern.length)
    if (fromPath === pattern) return path.basename(fromPath)
  }
  return path.basename(fromPath)
}

/** 带重试的 JSON 请求。 */
async function requestJson(url, headers, retries = 4) {
  let lastError
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { headers })
      if (response.status === 403 || response.status === 429) {
        lastError = new Error(`速率受限（HTTP ${response.status}）：GitHub 未认证请求每小时 60 次。可设 GH_TOKEN 环境变量提高额度`)
      } else if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`)
      } else {
        return await response.json()
      }
    } catch (error) {
      lastError = error
      if (/^HTTP 4/.test(String(error.message)) && !/速率受限/.test(error.message)) throw error
    }
    await new Promise(resolve => setTimeout(resolve, attempt * 1500))
  }
  throw lastError
}

/** 拼请求头；有 GH_TOKEN 就用（提高速率额度），没有也能跑。 */
function headers() {
  const token = process.env.GH_TOKEN
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dsh-whale-meme',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

/** 取上游默认分支的文件树（递归）与 commit。 */
export async function upstreamTree({ fetchImpl } = {}) {
  const api = 'https://api.github.com'
  const repo = await (fetchImpl ? fetchImpl(`${api}/repos/${UPSTREAM.slug}`) : requestJson(`${api}/repos/${UPSTREAM.slug}`, headers()))
  const branch = repo.default_branch ?? 'main'
  const treeUrl = `${api}/repos/${UPSTREAM.slug}/git/trees/${branch}?recursive=1`
  const tree = await (fetchImpl ? fetchImpl(treeUrl) : requestJson(treeUrl, headers()))
  const commit = await (fetchImpl
    ? fetchImpl(`${api}/repos/${UPSTREAM.slug}/commits/${branch}`)
    : requestJson(`${api}/repos/${UPSTREAM.slug}/commits/${branch}`, headers()))
  if (tree.truncated) {
    // 上游文件树被截断时必须说清楚，否则会静默漏文件
    throw new Error('上游文件树被 GitHub 截断（truncated），无法可靠列举；请改用 git clone')
  }
  return { branch, commit: commit.sha ?? null, tree: tree.tree ?? [] }
}

/**
 * 下载单个文件的内容（走 git blob API，按 sha 或按路径）。
 * 用 blob API 而不是 raw.githubusercontent.com：后者在本机被网络阻断。
 */
export async function downloadBlob(sha) {
  const url = `https://api.github.com/repos/${UPSTREAM.slug}/git/blobs/${sha}`
  const data = await requestJson(url, headers())
  return Buffer.from(String(data.content ?? '').replace(/\n/g, ''), 'base64')
}

/**
 * 执行下载。默认 dry-run。
 *
 * @param {object} input
 * @param {string} input.root - 工作区根目录
 * @param {string[]} input.bundleIds - 已解析的素材包 id
 * @param {boolean} [input.write] - 是否真下载
 * @param {(progress: object) => void} [input.onProgress]
 * @returns {Promise<object>}
 */
export async function fetchReferenceAssets(input) {
  const write = input.write === true
  const treeInfo = await upstreamTree()
  const plan = planDownloads(treeInfo.tree, input.bundleIds)

  const result = {
    upstream: { ...UPSTREAM, branch: treeInfo.branch, commit: treeInfo.commit },
    dryRun: !write,
    wrote: false,
    perBundle: plan.perBundle,
    fileCount: plan.selected.length,
    totalBytes: plan.totalBytes,
    totalBytesHuman: humanBytes(plan.totalBytes),
    files: plan.selected.map(file => ({ from: file.fromPath, to: file.toPath, size: file.size })),
  }

  if (!write) return result

  // 建立 sha 索引，才能按路径找到 blob sha
  const shaByPath = new Map(treeInfo.tree.filter(n => n.type === 'blob').map(n => [n.path, n.sha]))
  let downloaded = 0
  const failures = []
  for (const file of plan.selected) {
    const sha = shaByPath.get(file.fromPath)
    if (!sha) { failures.push({ path: file.fromPath, reason: '上游没有这个文件的 sha' }); continue }
    try {
      const buffer = await downloadBlob(sha)
      const absolute = path.join(input.root, ...file.toPath.split('/'))
      mkdirSync(path.dirname(absolute), { recursive: true })
      writeFileSync(absolute, buffer)
      const actual = createHash('sha256').update(buffer).digest('hex')
      file.sha256 = actual
      file.bytes = buffer.length
      downloaded += 1
      input.onProgress?.({ done: downloaded, total: plan.selected.length, path: file.toPath })
    } catch (error) {
      failures.push({ path: file.fromPath, reason: error.message })
    }
  }

  // 记来源：上游是 CC BY-NC-SA 4.0，必须留下可追溯记录
  const source = {
    upstream: UPSTREAM.slug,
    license: UPSTREAM.license,
    licenseNote: UPSTREAM.note,
    branch: treeInfo.branch,
    commit: treeInfo.commit,
    fetchedAt: new Date().toISOString(),
    bundles: input.bundleIds,
    files: plan.selected.map(file => ({
      path: file.toPath,
      upstreamPath: file.fromPath,
      bytes: file.bytes ?? file.size,
      sha256: file.sha256 ?? null,
    })),
  }
  const sourceFile = path.join(input.root, 'datas', '_fetched', 'SOURCE.json')
  mkdirSync(path.dirname(sourceFile), { recursive: true })
  writeFileSync(sourceFile, Buffer.from(`${JSON.stringify(source, null, 2)}\n`, 'utf8'))

  return {
    ...result,
    dryRun: false,
    wrote: true,
    downloaded,
    failures,
    sourceFile,
    // 全部下完才算 ok；有失败时明确报出来，不假装成功
    ok: failures.length === 0 && downloaded === plan.selected.length,
  }
}
