/**
 * dsh-whale-meme / reply —— 把结构化结果翻成「一眼能读」的自然语言回复。
 *
 * 为什么单独一层：工具的返回值要同时满足两种读者。
 *   * 机器（代理、脚本、测试）需要**结构化字段**才能判断与续跑 —— 所以字段一个都不删；
 *   * 人（在对话里看结果的人）需要**先看懂结论**，而不是先解析 JSON。
 *
 * 于是每个 action 都产出两份：结构化结果照旧，外加一个 `reply` 字段，
 * 并且工具的 `output.render` 优先渲染 `reply`。代理要细节就读字段，人要结论就读回复。
 *
 * 写作约定：
 *   * 先说结论（成没成、能不能用），再说数字，最后给出下一步；
 *   * 有问题时**一定**给可执行的下一步，不只报错；
 *   * 不堆砌字段名；必要处保留关键标识（文件名、sha 前 12 位、任务号）；
 *   * 纯文本 + 少量符号，不假设终端支持 emoji 之外的能力。
 *
 * @module dsh-whale-meme/reply
 */

import { TASK_FILES } from './core.mjs'

const OK = '✅'
const BAD = '❌'
const WARN = '⚠️'
const DOT = '·'

/** 字节数转人读大小。 */
function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/** sha256 取前 12 位用于展示。 */
function shortSha(sha) {
  return typeof sha === 'string' && sha.length >= 12 ? sha.slice(0, 12) : String(sha ?? '?')
}

function list(items, { empty = '无' } = {}) {
  return items.length > 0 ? items.join('、') : empty
}

/**
 * 生成自然语言回复。
 * @param {string} action
 * @param {object} result - runWhaleMeme 的结构化结果
 * @returns {string}
 */
export function formatReply(action, result) {
  try {
    const fn = REPLIES[action]
    if (fn) return fn(result).join('\n')
    // 没有专用模板时也要诚实：不要把失败说成「完成」
    if (result && result.ok === false) {
      const why = problems(result)
      return [`${BAD} ${action} 没能完成。`, ...(why.length > 0 ? ['', ...why.map(item => `  ${DOT} ${item}`)] : [])].join('\n')
    }
    return `${OK} ${action} 已完成（没有专用回复模板，细节见结构化字段）。`
  } catch (error) {
    // 回复层出错绝不能影响工具结果本身
    return `【${action}】已完成，但生成自然语言回复时出错：${error.message}（结构化字段仍可用）`
  }
}

/** 统一的错误尾巴：把 errors / error 摊平成人话。 */
function problems(result) {
  const out = []
  if (result.error) out.push(result.error)
  for (const item of result.errors ?? []) out.push(item)
  return out
}

function problemLines(result) {
  const lines = []
  for (const item of problems(result)) lines.push(`  ${DOT} ${item}`)
  return lines
}

// ─────────────────────────────── status ───────────────────────────────

function statusReply(result) {
  const tasks = result.tasks ?? []
  const missingStages = (result.taxonomy ?? []).filter(stage => !stage.exists)
  const lines = []

  if (result.ok) lines.push(`${OK} 工作区在 ${result.root}`)
  else lines.push(`${BAD} 没认到工作区${result.error ? `：${result.error}` : ''}`)

  lines.push('')
  lines.push(`四个阶段目录：${(result.taxonomy ?? []).map(stage => `${stage.dir}${stage.exists ? '✓' : '✗'}`).join('  ')}`)
  if (missingStages.length > 0) {
    lines.push(`  缺：${missingStages.map(stage => stage.dir).join('、')} —— 可用 init 补齐（只创建、不覆盖）`)
  }

  if (tasks.length === 0) {
    lines.push('')
    lines.push('目前还没有任务。可用 scaffold 建一个任务骨架。')
    return lines
  }

  lines.push('')
  lines.push(`共 ${tasks.length} 个任务：`)
  for (const task of tasks) {
    // 目录名形如 task01_标题，标题里已有任务号，别重复
    const title = task.title.replace(new RegExp(`^${task.id}_`), '')
    lines.push(`  ${DOT} ${task.id} · ${title}`)
    lines.push(`      提示词 ${task.textsFilesPresent}/${task.textsFilesTotal}${task.missingTextsFiles.length > 0 ? `（缺 ${task.missingTextsFiles.join('、')}）` : ''}，投喂负载 ${task.payloadIndex ? `${task.payloads} 份` : '还没有索引'}`)
    for (const model of task.models ?? []) {
      const deliverable = model.deliverables.length > 0
        ? `交付件 ${model.deliverables.join('、')}`
        : `${WARN} 没有推荐交付件`
      lines.push(`      ${model.model}：${model.images} 张图，${deliverable}${model.hasChecks ? '' : '，缺 checks.json'}`)
    }
    if ((task.warnings ?? []).length > 0) {
      for (const warning of task.warnings) lines.push(`      ${WARN} ${warning}`)
    }
  }

  const task0 = tasks[0]
  lines.push('')
  lines.push(`下一步：看某个任务的逐字文案用 task（例如 task="${task0.id}"）；确认投喂文本没被改过用 payload。`)
  return lines
}

// ─────────────────────────────── task ───────────────────────────────

function taskReply(result) {
  if (!result.ok) {
    return [`${BAD} 没能读取任务${result.task?.id ? ` ${result.task.id}` : ''}。`, '', ...problemLines(result),
      '', '请用 task 参数指定一个存在的任务号，或先跑 status 看有哪些任务。']
  }
  const storyboard = result.storyboard ?? {}
  const lines = []
  lines.push(`${OK} ${result.task.id} · ${result.task.title.replace(new RegExp(`^${result.task.id}_`), '')}`)
  lines.push('')
  lines.push(`提示词五件套：${result.files.filter(file => file.exists).length}/${result.files.length} 份齐全${result.missingFiles.length > 0 ? `（缺 ${result.missingFiles.join('、')}）` : ''}`)
  lines.push('')

  if (storyboard.ok && (storyboard.lines ?? []).length > 0) {
    lines.push('逐字文案（唯一权威文本，原样照抄，一个字都不能改）：')
    for (const line of storyboard.lines) {
      lines.push(`  ${line.marker ? `[${line.marker}] ` : ''}${line.text}`)
    }
    if ((storyboard.boldHints ?? []).length > 0) {
      lines.push(`必须加粗（且只有这些）：${storyboard.boldHints.join('、')}`)
    } else {
      lines.push('没有指定加粗。')
    }
  } else {
    lines.push(`${WARN} 没能解析出逐字文案。`)
  }

  if ((storyboard.warnings ?? []).length > 0) {
    lines.push('')
    lines.push(`${WARN} 文案格式有问题，先改再出图：`)
    for (const warning of storyboard.warnings) lines.push(`  ${DOT} ${warning}`)
  }

  lines.push('')
  lines.push(`下一步：换画风/尺寸/要求并看提示词用 preview；确认投喂文本用 payload。`)
  return lines
}

// ─────────────────────────────── payload ───────────────────────────────

function payloadReply(result) {
  if (!result.task) {
    return [`${BAD} 没能定位任务。`, '', ...problemLines(result), '', '请用 task 参数指定任务号。']
  }
  const lines = []
  const summary = result.summary ?? {}

  if (!result.indexExists) {
    lines.push(`${WARN} ${result.task} 还没有投喂负载索引（${result.reason ?? '_payload_index.json 不存在'}）。`)
    lines.push('')
    lines.push('下一步：跑 build 重建负载 —— 先 dry-run 看计划，确认后加 write=true。')
    return lines
  }

  if (result.ok) {
    lines.push(`${OK} ${result.task} 的投喂文本零改写：${summary.ok}/${summary.total} 份全部核对通过。`)
    lines.push('')
    lines.push('每一份都同时满足两件事：磁盘字节的 sha256 与索引记录一致，且正文仍逐字出现在它声称的来源文件里。')
  } else {
    lines.push(`${BAD} ${result.task} 的投喂负载有问题，别拿它出图。`)
  }

  lines.push('')
  for (const entry of result.entries ?? []) {
    const mark = entry.status === 'ok' ? OK : BAD
    lines.push(`  ${mark} ${entry.file}  ${shortSha(entry.actualSha256)}  ${entry.status}`)
    if (entry.status === 'payload-drift') {
      lines.push(`      磁盘上的负载与索引记录不符 —— 很可能被手打改写过。重跑 build 重建。`)
    } else if (entry.status === 'source-drift') {
      lines.push(`      正文已不在来源文件里（${entry.source ?? '来源未知'}）—— 上游 texts/ 改了但负载没重建。重跑 build。`)
    } else if (entry.status === 'missing') {
      lines.push(`      文件不存在 —— 重跑 build 重建。`)
    } else if (entry.status !== 'ok') {
      lines.push(`      来源：${entry.source ?? '未知'}。先修掉再出图。`)
    }
  }

  if (summary.drift > 0 || summary.sourceDrift > 0 || summary.missing > 0) {
    lines.push('')
    lines.push(`下一步：whale_meme(action="build", task="${result.task}", write=true) 重建，再用 payload 复核。`)
  } else {
    lines.push('')
    lines.push('下一步：可以放心出图了（preview 看提示词，或 commands 拿命令自己跑）。')
  }
  return lines
}

// ─────────────────────────────── lineage ───────────────────────────────

function lineageReply(result) {
  if (!result.task) {
    return [`${BAD} 没能定位任务。`, '', ...problemLines(result), '', '请用 task 参数指定任务号。']
  }
  const summary = result.summary ?? {}
  const unknown = (result.rows ?? []).filter(row => row.status === 'unknown-prompt')
  const lines = []

  if (result.ok) {
    lines.push(`${OK} ${result.task} 的产物血缘都追溯得上：${(result.rows ?? []).length} 张图没有一张对不上负载索引。`)
  } else {
    lines.push(`${BAD} ${result.task} 有 ${unknown.length} 张产物对不上负载索引。`)
  }
  if (summary.missingMetadata > 0) {
    lines.push(`另有无元数据的产物 ${summary.missingMetadata} 张（本地拼合产物属于正常，见下）。`)
  }
  lines.push('')

  lines.push('产物 → 用的是哪份负载：')
  for (const row of result.rows ?? []) {
    if (row.status === 'ok') lines.push(`  ${OK} ${row.model} / ${row.image}  ←  ${row.payload}`)
    else if (row.status === 'unknown-prompt') lines.push(`  ${BAD} ${row.model} / ${row.image}  ←  负载不在索引里（sha ${shortSha(row.promptSha256)}）`)
    else lines.push(`  ${DOT} ${row.model} / ${row.image}  无元数据（拼合产物属正常）`)
  }

  lines.push('')
  if (unknown.length > 0) {
    lines.push('对不上的通常是两种情况：负载被重建过（索引换了 sha），或当初是手打投喂的。')
    lines.push('这类产物不能作为「投喂零改写」的证据，建议用当前负载重出。')
  } else {
    lines.push('下一步：用 outputs 看尺寸与透明通道，然后按 04_验收清单.md 人眼逐字核对。')
  }
  return lines
}

// ─────────────────────────────── outputs ───────────────────────────────

function outputsReply(result) {
  if (!result.ok) {
    return [`${BAD} 没能读取产物${result.task ? `（${result.task}）` : ''}。`, '', ...problemLines(result),
      '', '确认任务号正确，且 outs/ 下确实有过出图。']
  }
  const lines = []
  lines.push(`${OK} ${result.task} 的产物清单：`)
  lines.push('')

  for (const model of result.models ?? []) {
    lines.push(`${model.model}（${model.images.length} 张，checks.json ${model.hasChecks ? '有' : '无'}）`)
    for (const image of model.images) {
      const flags = [
        image.deliverable ? '★推荐交付' : null,
        image.deprecate ? '弃用' : null,
        image.alphaChannel ? '带透明通道' : null,
        image.quality ? `${image.quality} 档` : null,
      ].filter(Boolean).join('，')
      lines.push(`  ${DOT} ${image.file}`)
      lines.push(`      ${image.size ?? '尺寸未知'}，${image.bytesHuman ?? humanBytes(image.bytes)}${flags ? `，${flags}` : ''}`)
    }
    for (const warning of model.warnings ?? []) lines.push(`  ${WARN} ${warning}`)
    lines.push('')
  }

  const opaque = (result.models ?? []).some(model => model.images.some(image => image.deliverable && image.alphaChannel === false))
  if (opaque) {
    lines.push('提示：有交付件不带透明通道。要透明贴纸得用 gpt-image-2.5-sunburst + background=transparent，或后期抠图。')
  }
  lines.push(`${WARN} 这些只是机械检查（尺寸、透明通道、元数据）。中文逐字、加粗范围、角色五要素、情绪反差必须人眼放大到 200% 核对。`)
  return lines
}

// ─────────────────────────────── commands ───────────────────────────────

function commandsReply(result) {
  if (!result.ok) {
    return [`${BAD} 没能生成命令。`, '', ...problemLines(result)]
  }
  if (!result.commands) {
    return [`${OK} 可用步骤：${(result.steps ?? []).join(' / ')}`,
      '',
      '用法：whale_meme(action="commands", step="<步骤>")，可再带 model / quality / size / background。',
      '',
      `Python 解释器：${result.python}`]
  }
  const lines = []
  lines.push(`${OK} ${result.step} 这一步的命令（可直接粘贴执行）：`)
  lines.push('')
  for (const command of result.commands) lines.push(command)
  if (result.model) {
    lines.push('')
    lines.push(`模型 ${result.model}${result.modelProfile ? `（${result.modelProfile.label}）` : ''}，质量档 ${result.modelProfile?.defaultQuality ?? '默认'}。`)
  }
  if ((result.caveats ?? []).length > 0) {
    lines.push('')
    lines.push('注意：')
    for (const caveat of result.caveats) lines.push(`  ${DOT} ${caveat}`)
  }
  return lines
}

// ─────────────────────────────── init ───────────────────────────────

function initReply(result) {
  const lines = []
  const willCreate = result.willCreate ?? []
  const alreadyExists = result.alreadyExists ?? []

  if (willCreate.length === 0) {
    lines.push(`${OK} 工作区已经完整，没有需要创建的东西。`)
  } else if (result.dryRun) {
    lines.push(`${OK} 工作区还缺 ${willCreate.length} 样东西（这是预览，还什么都没创建）：`)
    for (const item of willCreate) lines.push(`  ${DOT} ${item}`)
  } else {
    lines.push(`${OK} 已补齐 ${willCreate.length} 样缺失的目录与文件。`)
    for (const item of willCreate) lines.push(`  ${DOT} 已创建 ${item}`)
  }

  if (alreadyExists.length > 0) {
    lines.push('')
    lines.push(`已存在、一字未改：${list(alreadyExists)}`)
  }
  if (result.missingDirsBefore?.length > 0) {
    lines.push(`（运行前缺的目录：${list(result.missingDirsBefore)}）`)
  }

  lines.push('')
  if (result.dryRun && willCreate.length > 0) {
    lines.push('下一步：确认上面这份清单没问题后，加 write=true 重跑才会真正创建（只创建、不覆盖）。')
  } else if (result.after) {
    lines.push(result.after.missingDirs.length === 0 && result.after.missingFiles.length === 0
      ? '已复验：目录与占位文件都不缺了。下一步可以用 scaffold 建任务骨架。'
      : `仍有缺失：${list([...result.after.missingDirs, ...result.after.missingFiles])}`)
  }
  return lines
}

// ─────────────────────────────── scaffold ───────────────────────────────

function scaffoldReply(result) {
  const plan = result.plan
  if (!result.ok) {
    return [`${BAD} 没能新建任务。`, '', ...problemLines(result),
      '', '换一个任务号，或先确认那个目录是不是手工建过了。']
  }
  const lines = []
  if (result.wrote) lines.push(`${OK} 任务骨架已创建：${plan.dirName}`)
  else lines.push(`${OK} 这是新任务的计划（预览，还没写任何文件）：${plan.dirName}`)
  lines.push('')
  lines.push(`任务目录：${plan.textsDir}`)
  lines.push(`将包含 ${plan.files.length} 个文件：`)
  for (const file of plan.files) lines.push(`  ${DOT} ${file.fileName}（${file.chars} 字符）`)

  const roles = Object.entries(TASK_FILES)
  lines.push('')
  lines.push('各文件用途：')
  for (const [, fileName] of roles) {
    if (plan.files.some(file => file.fileName === fileName)) lines.push(`  ${DOT} ${fileName}`)
  }
  lines.push('')
  lines.push(`出图产物将来放：${plan.outDirHint}`)
  lines.push(`投喂负载将来放：${plan.payloadDirHint}`)
  lines.push('')
  if (result.wrote) {
    lines.push('接下来三件事，顺序别颠倒：')
    lines.push('  1. 把 00_分镜与文案锁定.md 的逐字文案定稿（句末用全角句号；整行括号只写加粗要求）')
    lines.push('  2. 在 .whale/manifest.json 给这个任务补 extraction 抽取计划，然后 build')
    lines.push('  3. 在 texts/README.md 的任务索引追加一行')
  } else {
    lines.push('下一步：确认路径与文件名无误后，加 write=true 重跑才会真正创建（拒绝覆盖已占用任务号）。')
  }
  return lines
}

// ─────────────────────────────── build ───────────────────────────────

function buildReply(result) {
  if (!result.ok) {
    const lines = [`${BAD} 没能重建投喂负载。`, '', ...problemLines(result)]
    if (problems(result).some(item => /extraction/.test(item))) {
      lines.push('')
      lines.push(`在 .whale/manifest.json 里给 ${result.task ?? '该任务'} 补一段 extraction 计划即可，例如：`)
      lines.push('  { "id": "task02", "extraction": { "payloads": [')
      lines.push('    { "file": "10_母图_中性站姿.txt", "from": "02_提示词_GPT-Image-2.5.md", "block": 2,')
      lines.push('      "source": "02_…§3 第0步（逐字）", "assert": "中性站姿全身母图" } ] } }')
      lines.push('assert 是防索引错位的断言短语，别省 —— 抽错内容的代价是一次付费出图。')
    }
    return lines
  }

  const changed = (result.entries ?? []).filter(entry => entry.changed)
  const lines = []
  if (result.dryRun) {
    lines.push(`${OK} 抽取计划没问题（预览，还没有写盘）：` + (result.wouldWrite > 0 ? `有 ${result.wouldWrite} 份会变化。` : '全部与磁盘现状一致。'))
  } else {
    lines.push(`${OK} 已重建 ${(result.written ?? []).length} 份投喂负载，并重写了 _payload_index.json。`)
  }
  lines.push('')
  for (const entry of result.entries ?? []) {
    const mark = entry.status === 'ok' ? OK : BAD
    const tag = entry.changed === false ? '（与磁盘一致）' : entry.changed === true ? `${WARN} 会变化` : ''
    lines.push(`  ${mark} ${entry.file}  ${shortSha(entry.sha256)}  ${entry.source ?? ''} ${tag}`.trim())
  }

  if (changed.length > 0 && result.dryRun) {
    lines.push('')
    lines.push(`标记「会变化」的 ${changed.length} 份说明磁盘上的内容与重新抽取的结果不同 —— 落盘后请用 payload 复核。`)
  }
  lines.push('')
  if (result.dryRun) {
    lines.push('下一步：确认无误后加 write=true 落盘，再用 payload 复核。')
  } else {
    const mismatched = (result.written ?? []).filter(item => !item.shaMatches)
    lines.push(mismatched.length === 0
      ? '落盘后逐份复验：磁盘字节的 sha256 与预告一致。下一步用 payload 复核。'
      : `${WARN} 有 ${mismatched.length} 份落盘后 sha 与预告不一致，请检查磁盘。`)
  }
  return lines
}

// ─────────────────────────────── preview ───────────────────────────────

function previewReply(result) {
  if (!result.planSummary) {
    return [`${BAD} 没能组装出图计划。`, '', ...problemLines(result),
      '', '如果是因为取不到基础提示词，可用 rawPrompt 直接给出提示词正文。']
  }
  const lines = []
  const plan = result.planSummary

  if (result.ok) lines.push(`${OK} 出图计划已就绪（这是预览，没有出图、没有花费）。`)
  else lines.push(`${BAD} 这个计划不合法，不能拿去出图，先按下面改。`)

  // 先给计划要点，再给问题 —— 人需要先知道「本来要出什么」
  lines.push('')
  lines.push(`任务 ${plan.task}，这一步是 ${plan.step}，模型 ${plan.modelLabel}。`)
  lines.push(`尺寸 ${plan.size}，质量档 ${plan.quality}，背景 ${plan.background ?? '不指定'}，预计 ${plan.estimatedSeconds} 秒/张。`)
  if (plan.style) lines.push(`画风预设：${plan.style}。`)
  for (const output of plan.outputs) lines.push(`产出：${output}`)
  lines.push(`提示词 sha256：${shortSha(plan.prompt.sha256)}`)

  if ((result.errors ?? []).length > 0) { lines.push(''); lines.push('问题：'); lines.push(...problemLines(result)) }
  if ((result.warnings ?? []).length > 0) {
    lines.push('')
    for (const warning of result.warnings) lines.push(`${WARN} ${warning}`)
  }

  lines.push('')
  if (result.ok) {
    lines.push(`确认无误就出图：把 confirm 设为 true，并带上令牌 ${result.token}`)
    lines.push('令牌一次性、10 分钟有效、参数一改就失效。每确认一次 = 一次付费调用。')
    lines.push('')
    lines.push('提示词全文：')
    lines.push(result.preview)
  } else {
    // 计划不合法时绝不能给出「可以出图」的指引，也不要贴令牌
    lines.push('改完参数重新 preview；计划不合法时不会给确认令牌。')
  }
  return lines
}

// ─────────────────────────────── render ───────────────────────────────

function renderReply(result) {
  const lines = []
  const plan = result.planSummary

  if (result.executed) {
    if (result.ok) {
      lines.push(`${OK} 出图完成。`)
      if (result.output) lines.push(`产物：${result.output.path}（${humanBytes(result.output.bytes)}）`)
      if (result.elapsedMs) lines.push(`耗时约 ${Math.round(result.elapsedMs / 1000)} 秒。`)
      if (result.meta) {
        const m = result.meta
        lines.push(`模型 ${m.model ?? '?'}，尺寸 ${m.size ?? '?'}，质量档 ${m.quality ?? '?'}，背景 ${m.background ?? '?'}。`)
        lines.push(m.statement ?? '')
      }
      lines.push('')
      lines.push('下一步：outputs 看尺寸与透明通道，然后按 04_验收清单.md 人眼逐字核对。')
    } else {
      lines.push(`${BAD} 出图没有成功。`)
      if (result.exitCode !== null && result.exitCode !== undefined) lines.push(`退出码 ${result.exitCode}。`)
      for (const error of result.errors ?? []) lines.push(`  ${DOT} ${error}`)
      if (result.stderrTail) {
        lines.push('')
        lines.push('客户端最后输出：')
        lines.push(result.stderrTail)
      }
      lines.push('')
      lines.push('不会自动重试 —— 重试要重新 preview 并确认，避免重复计费。')
    }
    return lines
  }

  // 没执行：要么未确认、要么被门禁拒了
  if ((result.errors ?? []).length > 0) {
    lines.push(`${BAD} 没有出图，计划被门禁拦下了。`)
    lines.push('')
    for (const error of result.errors) lines.push(`  ${DOT} ${error}`)
    lines.push('')
    lines.push('门禁规则：必须 confirm=true + preview 发的令牌；令牌一次性、10 分钟有效、计划一改就失效。')
    return lines
  }

  if (plan) {
    lines.push(`${OK} 出图计划已就绪，但**还没有出图**（没有花费）。`)
    lines.push('')
    lines.push(`任务 ${plan.task}，${plan.step}，${plan.modelLabel}，尺寸 ${plan.size}，质量档 ${plan.quality}。`)
    for (const output of plan.outputs) lines.push(`将产出：${output}`)
    if (result.costNote) lines.push('')
    if (result.costNote) lines.push(result.costNote)
    lines.push('')
    lines.push(`确认无误就出图：confirm=true，令牌 ${result.token}`)
    lines.push('令牌一次性、10 分钟有效、参数一改就失效。')
    lines.push('')
    lines.push('（这一步的完整提示词预览：先用 preview 看，或直接看本轮返回里的 preview 字段。）')
    return lines
  }

  // 既没执行、也没有计划与错误：说明输入本身不完整，别返回空回复
  if (result.error) lines.push(`${BAD} ${result.error}`)
  else if (result.executed === false && !result.planSummary) lines.push(`${BAD} 没能组出出图计划。`)
  else lines.push(`${BAD} 没有出图。`)
  lines.push('')
  lines.push('render 需要：task（或工作区里只有一个任务）、step、必要时的 rawPrompt / inputImage；')
  lines.push('先跑 preview 拿确认令牌，再带 confirm=true 与 token 调 render。')
  return lines
}

// ─────────────────────────────── fetch（下载参考素材）───────────────────────────────

function fetchReply(result) {
  const lines = []
  if (result.error && !result.perBundle) {
    return [`${BAD} 没能从上游取到素材清单。`, '', `  ${DOT} ${result.error}`, '',
      '可能是网络问题或 GitHub 速率受限。可设 GH_TOKEN 环境变量提高额度，或稍后重试。']
  }
  if (problems(result).length > 0 && !result.wrote) {
    lines.push(`${BAD} 下载计划有问题：`)
    lines.push(...problemLines(result))
    return lines
  }

  const bundles = result.perBundle ?? []
  lines.push(result.dryRun
    ? `${OK} 素材下载计划如下（这是预览，还没有下载任何文件）：`
    : `${OK} 已从上游下载参考素材：`)
  lines.push('')
  for (const bundle of bundles) {
    lines.push(`  ${DOT} ${bundle.label}`)
    lines.push(`      ${bundle.count} 个文件，${bundle.bytesHuman} → ${bundle.dest}/`)
    if (bundle.huge) lines.push(`      ${WARN} 体积很大，确认真的需要再下`)
    if (bundle.note) lines.push(`      ${bundle.note}`)
  }
  lines.push('')
  lines.push(`合计 ${result.fileCount} 个文件，${result.totalBytesHuman}。`)
  lines.push(`上游：${result.upstream.slug}（${result.upstream.branch} @ ${String(result.upstream.commit ?? '').slice(0, 10)}）`)
  lines.push('')

  if (result.dryRun) {
    lines.push('下一步：确认上面这份清单没问题后，加 write=true 才会真正下载（只往 datas/ 写）。')
  } else {
    lines.push(`已下载 ${result.downloaded}/${result.fileCount} 个文件。`)
    for (const failure of result.failures ?? []) lines.push(`  ${BAD} ${failure.path} —— ${failure.reason}`)
    if (result.sourceFile) lines.push(`来源记录已写入：${result.sourceFile}`)
    lines.push('')
    lines.push(result.ok
      ? '下一步：用 status 看工作区识别情况；若立绘刚下好，可以直接进 preview 出图。'
      : `${WARN} 有文件没下成功，重跑同一条命令即可补齐（已下好的会被覆盖，不会重复占用）。`)
  }
  lines.push('')
  lines.push(`${WARN} 上游素材是 **${result.upstream.license}**：保留署名、非商业、相同方式共享；`)
  lines.push('   参考语料只作风格/题材参考，不得作为成品交付。')
  return lines
}

// ─────────────────────────────── draft（自由需求 → 草稿）───────────────────────────────

function draftReply(result) {
  const lines = []
  const template = result.template ?? {}
  lines.push(`${OK} 收到需求，下面是待填写的草稿模板（这一步不写任何文件、不出图）。`)
  lines.push('')
  if (template.narrative) {
    lines.push('你的需求：')
    lines.push(`  ${template.narrative}`)
    lines.push('')
  }
  lines.push('请照这个结构产出一份草稿，再调 whale_meme(action="draftCheck", draft=<这份草稿>) 校验：')
  lines.push('')
  lines.push(JSON.stringify(template, null, 2))
  lines.push('')
  lines.push('填写要点（逐条都要满足，否则校验会挡住）：')
  for (const item of result.checklist ?? []) lines.push(`  ${DOT} ${item}`)
  lines.push('')
  lines.push('可选的画风预设与尺寸：')
  lines.push(`  画风  ${(result.options?.styles ?? []).map(s => `${s.id}（${s.label}）`).join(' / ')}`)
  lines.push(`  尺寸  ${(result.options?.sizes ?? []).join(' / ')}`)
  lines.push('')
  lines.push('校验通过后，回复里会给出完整草稿供你**逐字修改**；确认无误再走 scaffold 落盘。')
  return lines
}

// ─────────────────────────────── draftCheck（校验草稿）───────────────────────────────

function draftCheckReply(result) {
  const lines = []
  if (!result.ok) {
    lines.push(`${BAD} 草稿还不能用，有 ${(result.errors ?? []).length} 处要改：`)
    lines.push('')
    for (const error of result.errors ?? []) lines.push(`  ${DOT} ${error}`)
    if ((result.warnings ?? []).length > 0) {
      lines.push('')
      lines.push('另外提醒：')
      for (const warning of result.warnings) lines.push(`  ${DOT} ${warning}`)
    }
    lines.push('')
    lines.push('改完再调一次 draftCheck。**这一步不写文件、不出图**，可以反复改到满意。')
    return lines
  }

  lines.push(`${OK} 草稿校验通过。下面这份就是要画进图里的东西，**请逐字校对**：`)
  lines.push('')
  lines.push(result.rendered)
  if ((result.warnings ?? []).length > 0) {
    lines.push('')
    lines.push('提醒：')
    for (const warning of result.warnings) lines.push(`  ${DOT} ${warning}`)
  }
  lines.push('')
  lines.push(`要改就直接说改哪里（例如「下格改成『文件被我改烂了。』」），改完再调一次 draftCheck。`)
  lines.push(`确认无误后：用 scaffold 建任务 → 把逐字文案写进 00_分镜与文案锁定.md → build 抽负载 → preview 出图。`)
  return lines
}

const REPLIES = {
  status: statusReply,
  task: taskReply,
  payload: payloadReply,
  lineage: lineageReply,
  outputs: outputsReply,
  commands: commandsReply,
  init: initReply,
  scaffold: scaffoldReply,
  build: buildReply,
  preview: previewReply,
  render: renderReply,
  fetch: fetchReply,
  draft: draftReply,
  draftCheck: draftCheckReply,
}
