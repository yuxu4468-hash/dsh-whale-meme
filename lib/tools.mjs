/**
 * dsh-whale-meme / tools —— whale_meme 工具的动作实现与输出渲染。
 *
 * 一个工具、多个 action（与 skill/vision 工具的组织方式一致）：
 *   status   工作区全景：阶段、任务、负载、产物、契约、环境约束
 *   task     单任务体检：分镜逐字文案 + 五份文件 + 负载索引 + 产物
 *   payload  负载与来源的逐字一致性核验（防止投喂文本被手打改写）
 *   lineage  产物元数据 prompt.sha256 ↔ 负载索引对齐
 *   outputs  产物机械自检汇总：尺寸 / 透明通道 / 元数据 / 推荐交付件
 *   commands 逐字复现某一步的命令（gen / edit / compose / check / build）
 *   scaffold 新建任务骨架（默认 dry-run，必须显式 write=true 才落盘）
 *   init     补齐工作区缺的目录与文件（默认 dry-run，只创建不覆盖）
 *   preview  组装「文本之外的要求」→ 出图计划 + 提示词预览 + 确认令牌（不落盘、不出图）
 *   build    按清单里的抽取计划从 texts/ 逐字重建投喂负载（默认 dry-run）
 *   render   确认后直接出图（默认只出计划；真出图需 confirm=true + 有效令牌，每张计费）
 *   fetch    从上游开源仓库下载参考素材（默认 dry-run，只往 datas/ 写，并记来源）
 *   draft    自由需求 → 待填写草稿模板 + 校验清单（不落盘，由 LLM 填、用户校）
 *   draftCheck 校验并结构化 LLM 填好的草稿 → 供用户逐字复核（不落盘）
 *
 * @module dsh-whale-meme/tools
 */

import {
  ENVIRONMENT_RULES,
  MODEL_PROFILES,
  SILHOUETTE_ANCHORS,
  STAGES,
  TASK_FILES,
  auditOuts,
  buildContract,
  existsSyncSafe,
  findTextsDir,
  formatBytes,
  listTasks,
  matchTask,
  parseStoryboard,
  readManifest,
  readPayloadIndex,
  readText,
  resolveWorkspaceRoot,
  verifyPayloadIndex,
  verifyPromptLineage,
} from './core.mjs'
import path from 'node:path'
import { TASK_COMMANDS, buildCommandStep, resolvePython, WORKSPACE_TOOLS } from './commands.mjs'
import { scaffoldTask } from './scaffold.mjs'
import { STYLE_PRESETS, buildRenderPlan, formatPreview, normalizeRequirements, planToken } from './requirements.mjs'
import { buildPayloads } from './payloads.mjs'
import { codeFences, loadManifest, saveManifest, taskFilePath } from './manifest.mjs'
import { checkToken, consumeToken, executeRender, issueToken, liveTokenCount } from './render.mjs'
import { formatReply } from './reply.mjs'
import { BUNDLES, DEFAULT_BUNDLES, fetchReferenceAssets, resolveBundles } from './fetch.mjs'
import { checkDraft, describeOptions, draftChecklist, draftTemplate, draftToTextsFiles, renderDraft } from './draft.mjs'
import { initWorkspace, inspectWorkspace } from './workspace.mjs'

/** 工具名（模型可见名，必须稳定）。 */
export const TOOL_NAME = 'whale_meme'

/** 工具可见描述。 */
export const TOOL_DESCRIPTION = [
  '「蓝色大肥鱼表情包绘画」工作区的机械校验、素材下载、提示词起草与出图入口：',
  'status（工作区全景）/ task（单任务逐字文案）/ payload（投喂负载是否被改写）/ lineage（产物血缘）/',
  'outputs（尺寸与透明通道）/ commands（逐字复现命令）/ scaffold（新任务骨架）/ init（补齐工作区目录）/',
  'preview（把画风、尺寸、质量档、透明底、附加要求组装成出图计划并预览提示词）/ build（逐字重建投喂负载）/',
  'render（确认后直接出图：默认只出计划，真出图必须 confirm=true 且带 preview 给的令牌，每张按张计费）/',
  'fetch（从上游开源仓库 EDMOK/blue-fish-archive 下载角色参考素材，默认 dry-run，只往 datas/ 写并记来源）/',
  'draft（一句自由需求 → 待填写的草稿模板 + 校验清单，由 LLM 依此产出文案）/',
  'draftCheck（校验并结构化草稿，返回完整草稿供用户逐字复核修改）。',
  `角色剪影三要素：${SILHOUETTE_ANCHORS.join('；')}。`,
].join('')

/** 支持的 action 列表。 */
export const ACTIONS = [
  'status', 'task', 'payload', 'lineage', 'outputs', 'commands', 'scaffold',
  'init', 'preview', 'build', 'render', 'fetch', 'draft', 'draftCheck',
]

/** 会写盘的 action（默认 dry-run，需显式 write/confirm）。 */
export const WRITING_ACTIONS = ['scaffold', 'init', 'build', 'render', 'fetch']

/**
 * 执行一次 whale_meme 调用。
 *
 * 返回值有两份读者：结构化字段给机器判断，`reply` 字段给人一眼读懂。
 * 所以这里统一收口：先算结构化结果，再挂上 `reply`（绝不让回复层影响结构化结果）。
 *
 * @param {object} args - 工具参数（已按 schema 校验）。
 * @param {{env?: Record<string, string|undefined>, cwd?: string, workspaceRoot?: string|null, spawn?: Function}} [context]
 * @returns {object|Promise<object>} 可 JSON 序列化的结果对象，含自然语言 `reply`。
 */
export function runWhaleMeme(args = {}, context = {}) {
  const outcome = dispatchWhaleMeme(args, context)
  if (outcome && typeof outcome.then === 'function') {
    return outcome.then(result => withReply(args, result))
  }
  return withReply(args, outcome)
}

/** 把结构化结果加上自然语言回复。 */
function withReply(args, result) {
  if (!result || typeof result !== 'object') return result
  const action = String(result.action ?? args.action ?? 'status')
  return { ...result, reply: formatReply(action, result) }
}

/** 纯分发：只产出结构化结果。 */
function dispatchWhaleMeme(args = {}, context = {}) {
  const action = String(args.action ?? 'status')
  if (!ACTIONS.includes(action)) {
    return { ok: false, action, error: `未知 action：${action}；可用：${ACTIONS.join(', ')}` }
  }
  let root
  try {
    root = resolveWorkspaceRoot({
      root: context.workspaceRoot ?? null,
      startDir: context.cwd,
      env: context.env ?? process.env,
    }).root
  } catch (error) {
    return { ok: false, action, error: error.message }
  }
  const tasks = listTasks(root)
  // 选择口径：给了 task 就必须匹配上，**不做静默回退** ——
  // 「你指定了 A，它却动了 B」是这类工具最危险的失误（此前 quality 被静默忽略就是同类问题）。
  let task = null
  let taskError = null
  if (args.task) {
    task = matchTask(tasks, args.task)
    if (!task) {
      taskError = `没有匹配到任务「${args.task}」；当前工作区有：${listTasks(root).map(entry => entry.id).join('、') || '（无）'}`
    }
  } else if (tasks.length === 1) {
    task = tasks[0]
  } else if (tasks.length > 1) {
    taskError = `工作区里有 ${tasks.length} 个任务，请用 task 参数指定：${tasks.map(entry => entry.id).join('、')}`
  }

  switch (action) {
    case 'status':
      return statusReport(root, tasks)
    case 'task':
      return taskError ? { ok: false, action, root, error: taskError } : taskReport(root, task, tasks, args.task)
    case 'payload':
      return taskError ? { ok: false, action, root, error: taskError } : payloadReport(root, task, args.task)
    case 'lineage':
      return taskError ? { ok: false, action, root, error: taskError } : lineageReport(root, task, args.task)
    case 'outputs':
      return taskError ? { ok: false, action, root, error: taskError } : outputsReport(root, task, args.task)
    case 'commands':
      return commandsReport(root, task, args, tasks)
    case 'scaffold':
      return scaffoldReport(root, args)
    case 'init':
      return initReport(root, args)
    case 'preview':
      return taskError ? { ok: false, action, root, error: taskError } : previewReport(root, task, args)
    case 'build':
      return taskError ? { ok: false, action, root, error: taskError } : buildReport(root, task, args)
    case 'render':
      return taskError ? { ok: false, action, root, step: args.step ?? null, error: taskError } : renderReport(root, task, args, context)
    case 'fetch':
      return fetchReport(root, args)
    case 'draft':
      return draftReport(args)
    case 'draftCheck':
      return draftCheckReport(args)
    default:
      return { ok: false, action, error: '不可达分支' }
  }
}

// ─────────────────────────────── status ───────────────────────────────

function statusReport(root, tasks) {
  const taxonomy = STAGES.map(stage => ({
    stage: stage.id,
    label: stage.label,
    dir: stage.dir,
    writeOwner: stage.writeOwner,
    exists: existsSyncSafe(path.join(root, ...stage.dir.split('/'))),
  }))
  const taskRows = tasks.map(entry => {
    const payload = readPayloadIndex(root, entry.id)
    const outputs = auditOuts(root, entry.id)
    const textsFiles = entry.textsDir
      ? Object.entries(TASK_FILES).map(([key, fileName]) => ({ key, fileName, exists: existsSyncSafe(path.join(entry.textsDir, fileName)) }))
      : []
    return {
      id: entry.id,
      title: entry.title,
      textsDir: entry.textsDir,
      outsDir: entry.outsDir,
      textsFilesPresent: textsFiles.filter(file => file.exists).length,
      textsFilesTotal: textsFiles.length,
      missingTextsFiles: textsFiles.filter(file => !file.exists).map(file => file.fileName),
      payloads: payload.payloads.length,
      payloadIndex: payload.exists,
      models: (outputs.models ?? []).map(model => ({
        model: model.model,
        images: model.images.length,
        deliverables: model.deliverables.map(image => image.file),
        hasChecks: Boolean(model.checkFile),
      })),
      acceptanceFile: outputs.acceptanceFile,
      warnings: outputs.warnings ?? [],
    }
  })
  const manifest = readManifest(root)
  return {
    ok: true,
    action: 'status',
    root,
    taxonomy,
    tasks: taskRows,
    manifest: { file: manifest.file, exists: manifest.exists, tasks: manifest.manifest?.tasks?.length ?? 0 },
    silhouetteAnchors: SILHOUETTE_ANCHORS,
    environmentRules: ENVIRONMENT_RULES,
    tools: WORKSPACE_TOOLS.map(tool => ({ file: tool.file, role: tool.role, exists: existsSyncSafe(path.join(root, ...tool.file.split('/'))) })),
    contractPreview: buildContract(root).split('\n').slice(0, 6),
  }
}

// ─────────────────────────────── task ───────────────────────────────

function taskReport(root, task, tasks, selector) {
  if (!task) {
    return {
      ok: false,
      action: 'task',
      error: selector
        ? `没有匹配到任务「${selector}」；可用：${tasks.map(entry => entry.id).join(', ') || '（无）'}`
        : `工作区里有 ${tasks.length} 个任务，请用 task 参数指定（可用：${tasks.map(entry => entry.id).join(', ')}）`,
    }
  }
  const storyboard = parseStoryboard(root, task.id)
  const textsDir = findTextsDir(root, task.id)
  const files = textsDir
    ? Object.entries(TASK_FILES).map(([key, fileName]) => {
      const abs = path.join(textsDir, fileName)
      const exists = existsSyncSafe(abs)
      return { key, fileName, exists, bytes: exists ? readText(abs).length : null }
    })
    : []
  return {
    ok: true,
    action: 'task',
    root,
    task: { id: task.id, title: task.title, textsDir: task.textsDir, outsDir: task.outsDir },
    files,
    missingFiles: files.filter(file => !file.exists).map(file => file.fileName),
    storyboard: {
      file: storyboard.storyboardFile,
      ok: storyboard.ok,
      lines: storyboard.lines,
      boldHints: storyboard.boldHints,
      warnings: storyboard.warnings,
    },
    instruction:
      '逐字文案是本任务的唯一权威文本（lines[].text 原样照抄）。出图阶段不得改写、不得加说话人姓名或标题；'
      + 'boldHints 列出的字必须加粗，且只有这些字加粗。',
  }
}

// ─────────────────────────────── payload ───────────────────────────────

function payloadReport(root, task, selector) {
  if (!task) return { ok: false, action: 'payload', error: `没有匹配到任务「${selector ?? ''}」` }
  const verified = verifyPayloadIndex(root, task.id)
  const index = readPayloadIndex(root, task.id)
  return {
    ok: verified.ok,
    action: 'payload',
    root,
    task: task.id,
    payloadDir: index.dir,
    indexFile: index.indexFile,
    indexExists: index.exists,
    entries: verified.entries.map(entry => ({
      file: entry.file,
      bytes: entry.actualBytes ?? entry.bytes,
      chars: entry.chars,
      recordedSha256: entry.sha256,
      actualSha256: entry.actualSha256,
      source: entry.source,
      matchesRecord: entry.matchesRecord ?? null,
      matchesTextSource: entry.matchesTextSource ?? null,
      status: entry.status,
    })),
    summary: {
      total: verified.entries.length,
      ok: verified.entries.filter(entry => entry.status === 'ok').length,
      drift: verified.entries.filter(entry => entry.status === 'payload-drift').length,
      sourceDrift: verified.entries.filter(entry => entry.status === 'source-drift').length,
      missing: verified.entries.filter(entry => entry.status === 'missing').length,
    },
    reason: verified.reason,
    instruction:
      'status=ok 表示磁盘上的负载字节与索引记录一致，且负载正文仍逐字出现在它声称的 texts/ 来源文件里 —— '
      + '这是「投喂文本没有被手打改写」的机器证据。任何非 ok 都必须重新抽出负载后再出图。',
  }
}

// ─────────────────────────────── lineage ───────────────────────────────

function lineageReport(root, task, selector) {
  if (!task) return { ok: false, action: 'lineage', error: `没有匹配到任务「${selector ?? ''}」` }
  const lineage = verifyPromptLineage(root, task.id)
  return {
    ok: lineage.ok,
    action: 'lineage',
    root,
    task: lineage.task,
    payloadCount: lineage.payloadCount,
    rows: lineage.rows,
    summary: {
      unknownPrompt: lineage.unknown,
      missingMetadata: lineage.missing,
      unaligned: lineage.unaligned,
    },
    warnings: lineage.warnings,
    instruction:
      '每一张产物的同名 .json 里记录着本次投喂文本的 prompt.sha256；它与 _payload_index.json 对齐，'
      + '才能证明投喂没被改写。status=unknown-prompt 说明该产物用的负载已不在索引里（负载被重建过或手打投喂）；'
      + 'status=no-metadata 表示该产物没有元数据（本地拼合产物 compose_panels.py 不写元数据，属正常）。'
      + 'ok 的判据是「没有任何一张产物对不上索引」。',
  }
}

// ─────────────────────────────── outputs ───────────────────────────────

function outputsReport(root, task, selector) {
  if (!task) return { ok: false, action: 'outputs', error: `没有匹配到任务「${selector ?? ''}」` }
  const audit = auditOuts(root, task.id)
  return {
    ok: audit.exists && (audit.models ?? []).length > 0,
    action: 'outputs',
    root,
    task: audit.task,
    outsDir: audit.outsDir,
    acceptanceFile: audit.acceptanceFile,
    models: (audit.models ?? []).map(model => ({
      model: model.model,
      dir: model.dir,
      hasChecks: Boolean(model.checkFile),
      report: model.reportFile,
      images: model.images.map(image => ({
        file: image.file,
        size: image.size,
        bytes: image.bytes,
        bytesHuman: formatBytes(image.bytes ?? 0),
        alphaChannel: image.hasAlphaChannel,
        deprecate: image.deprecate,
        deliverable: image.deliverable,
        metaFile: image.metaFile,
        promptSha256: image.metaSha256,
        requestSize: image.metaRequestSize,
        quality: image.metaQuality,
        background: image.metaBackground,
      })),
      warnings: model.warnings ?? [],
    })),
    warnings: audit.warnings ?? [],
    instruction:
      '图片尺寸与透明通道来自 PNG 头的直接解析。透明底只有 gpt-image-2.5 系支持（background: transparent）；'
      + 'gpt-image-2 的产物即使看起来是白底也不含 alpha 通道，必须后期抠图。',
  }
}

// ─────────────────────────────── scaffold ───────────────────────────────

function scaffoldReport(root, args) {
  const result = scaffoldTask(root, {
    title: args.title,
    number: typeof args.number === 'number' ? args.number : Number.parseInt(args.number ?? '', 10),
    write: args.write === true,
  })
  const plan = result.plan
  return {
    ok: result.ok,
    action: 'scaffold',
    root,
    wrote: result.wrote,
    dryRun: result.dryRun === true,
    error: result.error,
    plan: plan && {
      taskId: plan.taskId,
      title: plan.title,
      dirName: plan.dirName,
      textsDir: plan.textsDir,
      outDirHint: plan.outDirHint,
      payloadDirHint: plan.payloadDirHint,
      files: plan.files,
      conflicts: plan.conflicts,
    },
    instruction: result.wrote
      ? '骨架已创建。接下来：① 在 00_分镜与文案锁定.md 里把逐字文案与加粗位置定稿（标记行只分组、括号只写加粗要求、句末用全角句号）；'
        + '② 填 01/02 两份提示词；③ 改 _tools/build_payloads.py 顶部的 TASK/OUT 常量后跑 build；'
        + '④ 用 whale_meme(action="payload") 核验后再出图；⑤ 把本任务追加到 texts/README.md 的任务索引。'
      : '这是 dry-run，没有写任何文件。确认上面的路径与文件名后，用 write=true 重跑才会真正创建。',
  }
}

// ─────────────────────────────── init ───────────────────────────────

function initReport(root, args) {
  const before = inspectWorkspace(root)
  const result = initWorkspace(root, { write: args.write === true, withReadme: args.withReadme !== false })
  return {
    ok: result.dryRun ? result.createCount >= 0 : result.wrote && result.verified !== false,
    action: 'init',
    root,
    dryRun: result.dryRun,
    wrote: result.wrote,
    recognizedBefore: result.recognizedBefore,
    recognitionEvidence: result.evidence,
    missingDirsBefore: result.before.missingDirs,
    missingFilesBefore: result.before.missingFiles,
    willCreate: result.actions.filter(action => action.willCreate).map(action => action.relative),
    alreadyExists: result.actions.filter(action => action.alreadyExists).map(action => action.relative),
    createCount: result.createCount,
    skipCount: result.skipCount,
    after: result.after ?? null,
    instruction: result.dryRun
      ? '这是 dry-run，没有创建任何东西。确认 willCreate 列表后，用 write=true 重跑才会真正创建（只创建、不覆盖）。'
      : '已创建缺失的目录与文件；已存在的文件一字未改。',
  }
}

// ─────────────────────────── 基础提示词定位 ───────────────────────────

/**
 * 找出某个任务、某个 step 要用的「基础提示词」正文（逐字）。
 * 优先用清单里的 extraction 计划；没有计划时按文件名 + 代码块序号推导。
 */
function resolveBasePrompt(root, taskEntry, step, manifest, explicit) {
  if (explicit) return { text: explicit, source: '<调用方直接提供>' }
  if (!taskEntry?.textsDir) return { text: null, source: null, reason: '找不到任务目录' }
  const dirName = path.basename(taskEntry.textsDir)
  const fileFor = {
    whole: /gpt-image-2\.5/.test(step) ? '02_提示词_GPT-Image-2.5.md' : '02_提示词_GPT-Image-2.5.md',
    mother: '02_提示词_GPT-Image-2.5.md',
    upper: '02_提示词_GPT-Image-2.5.md',
    lower: '02_提示词_GPT-Image-2.5.md',
  }[step] ?? '02_提示词_GPT-Image-2.5.md'
  const file = taskFilePath(root, dirName, fileFor)
  if (!existsSyncSafe(file)) return { text: null, source: null, reason: `找不到 ${fileFor}` }
  const fences = codeFences(readText(file))
  // build_payloads.py 的索引：0=参数，1=整图主提示词，2=母图，3=上格，4=下格
  const blockByStep = { whole: 1, mother: 2, upper: 3, lower: 4 }
  const block = blockByStep[step]
  const fence = fences[block]
  if (!fence) return { text: null, source: null, reason: `${fileFor} 取不到第 ${block} 个代码块` }
  return { text: fence.body, source: `${fileFor} 代码块 #${block}（逐字）` }
}

// ─────────────────────────────── preview ───────────────────────────────

function previewReport(root, taskEntry, args) {
  if (!taskEntry) {
    return { ok: false, action: 'preview', error: `没有匹配到任务「${args.task ?? ''}」；请用 task 参数指定` }
  }
  const built = assemblePlan(root, taskEntry, args)
  if (!built.plan) {
    return { ok: false, action: 'preview', root, errors: built.errors, warnings: built.warnings }
  }
  const plan = built.plan
  const token = built.token
  // 计划不合法时**不发令牌**：令牌代表「这份计划可以出图」，
  // 发给一份出不了的计划只会误导调用方（render 侧另有合法性检查兜底）。
  if (built.ok) issueToken(token, plan)
  return {
    ok: built.ok,
    action: 'preview',
    root,
    task: taskEntry.id,
    step: plan.step,
    errors: built.errors,
    warnings: built.warnings,
    token: built.ok ? token : null,
    tokenNote: built.ok
      ? `这是「确认令牌」，出图时原样带回。有效期 10 分钟、一次性使用、计划改动即失效。当前有效令牌 ${liveTokenCount()} 个。`
      : '计划不合法，没有发放令牌。改完参数重新 preview。',
    planSummary: summarizePlan(plan),
    preview: built.preview,
    styles: Object.values(STYLE_PRESETS).map(preset => ({
      id: preset.id,
      label: preset.label,
      size: preset.size ?? null,
      notes: preset.notes ?? null,
    })),
    instruction: built.ok
      ? '确认预览无误后，调用 whale_meme(action="render", confirm=true, token="…") 即出图。每张按张计费。'
      : '计划里有错误（见 errors），先修掉再确认。',
  }
}

/** 默认输入图：mother 用参考立绘，upper/lower 用上一步产物，whole 不需要。 */
function defaultInputImage(root, taskEntry, step) {
  const dirName = taskEntry.title ?? (taskEntry.textsDir ? path.basename(taskEntry.textsDir) : null)
  if (!dirName) return null
  const characterSheet = path.join(root, 'datas', '01_character', '原始立绘_deepseek_whale.png')
  if (step === 'mother') return existsSyncSafe(characterSheet) ? characterSheet : null
  const model = 'gpt-image-2.5-sunburst'
  const base = path.join(root, 'outs', dirName, model)
  if (step === 'upper') return path.join(base, '01_母图_中性站姿_1024.png')
  if (step === 'lower') return path.join(base, '02_上格_自信_1024.png')
  return null
}

function summarizePlan(plan) {
  return {
    task: plan.task,
    step: plan.step,
    model: plan.model,
    modelLabel: plan.modelLabel,
    endpoint: plan.endpoint,
    size: plan.size,
    quality: plan.quality,
    background: plan.background,
    inputImage: plan.inputImage,
    outputs: plan.outputs.map(output => output.absolutePath),
    style: plan.stylePreset?.id ?? null,
    requirements: plan.requirements,
    prompt: { chars: plan.prompt.chars, sha256: plan.prompt.sha256, source: plan.prompt.source },
    estimatedSeconds: plan.estimatedSeconds,
  }
}

// ─────────────────────────────── build ───────────────────────────────

function buildReport(root, taskEntry, args) {
  if (!taskEntry) {
    return { ok: false, action: 'build', error: `没有匹配到任务「${args.task ?? ''}」；请用 task 参数指定` }
  }
  const manifest = loadManifest(root).manifest
  const dirName = taskEntry.title ?? path.basename(taskEntry.textsDir ?? '')
  const result = buildPayloads({
    root,
    task: taskEntry.id,
    taskDirName: dirName,
    manifest,
    write: args.write === true,
  })
  return {
    ok: result.ok,
    action: 'build',
    root,
    task: taskEntry.id,
    dryRun: result.dryRun,
    wrote: result.wrote,
    outDir: result.outDir,
    errors: result.errors ?? [],
    warnings: result.warnings ?? [],
    entries: result.entries ?? [],
    written: result.written ?? null,
    wouldWrite: result.wouldWrite ?? null,
    indexFile: result.indexFile ?? null,
    shaNote: 'sha256 对磁盘上的实际字节取，与出图元数据里的 prompt.sha256 同口径。',
    instruction: result.dryRun
      ? '这是 dry-run：只算了每份负载的 sha256 与变化情况，没有写盘。确认后用 write=true 落盘。'
      : '已落盘并重建 _payload_index.json。建议接着跑 whale_meme(action="payload") 复核。',
  }
}

// ─────────────────────────────── render ───────────────────────────────

async function renderReport(root, taskEntry, args, context) {
  if (!taskEntry) {
    return { ok: false, action: 'render', error: `没有匹配到任务「${args.task ?? ''}」；请用 task 参数指定` }
  }

  // 只组装一次计划。**绝不在这里 issue 令牌** —— 否则 render 会把刚用掉的令牌重新发出来，
  // 令牌的一次性语义就被自己绕过了（这个 bug 在门禁测试里被抓住过）。
  const built = assemblePlan(root, taskEntry, args)
  if (!built.plan || !built.ok) {
    return { ok: false, action: 'render', executed: false, errors: built.errors, warnings: built.warnings, gate: '计划不合法，已拒绝出图（不产生费用）。' }
  }
  const plan = built.plan
  const summary = summarizePlan(plan)
  const costNote = `本次将产生 1 次付费调用（${summary.modelLabel} · ${summary.quality} 档 · 预计 ${summary.estimatedSeconds} 秒）。`

  if (args.confirm !== true) {
    return {
      ok: true,
      action: 'render',
      root,
      task: taskEntry.id,
      step: plan.step,
      executed: false,
      dryRun: true,
      token: built.token,
      tokenNote: '这是确认令牌：确认无误后带 confirm=true 与 token 重跑即可出图。10 分钟有效、一次性。',
      planSummary: summary,
      preview: built.preview,
      costNote,
      gate: '未确认：render 默认不出图。看完预览确认无误后，带 confirm=true 与上面的 token 重跑。',
    }
  }

  const verdict = checkToken(args.token, plan)
  if (!verdict.ok) {
    return {
      ok: false,
      action: 'render',
      executed: false,
      errors: [verdict.reason],
      planSummary: summary,
      costNote,
      gate: '令牌校验未通过，已拒绝出图（不产生费用）。',
    }
  }

  if (typeof context.spawn !== 'function') {
    return {
      ok: false,
      action: 'render',
      executed: false,
      errors: ['宿主没有提供子进程能力，无法执行出图。请改用 whale_meme(action="commands") 拿命令自行执行。'],
      planSummary: summary,
    }
  }

  // 先消耗令牌再执行：即便执行失败，令牌也不复用（重试要重新确认）
  consumeToken(args.token)
  const clientScript = path.join(root, '_tools', 'whale_image_client.py')
  const result = await executeRender({
    plan,
    pythonPath: resolvePython(),
    clientScript,
    spawn: context.spawn,
  })
  return {
    ok: result.ok,
    action: 'render',
    root,
    task: taskEntry.id,
    executed: result.executed,
    exitCode: result.exitCode ?? null,
    elapsedMs: result.elapsedMs ?? null,
    output: result.output ?? null,
    meta: result.meta ?? null,
    errors: result.errors ?? [],
    promptFile: result.promptFile ?? null,
    promptSha256: result.promptSha256OnDisk ?? null,
    stdoutTail: result.stdoutTail ?? null,
    stderrTail: result.stderrTail ?? null,
    scheduleNote: result.scheduleNote ?? null,
    instruction: result.ok
      ? '出图完成。接着跑 whale_meme(action="outputs") 看尺寸与透明通道，然后按 04_验收清单.md 人眼逐字核对。'
      : '出图未成功，见 errors / stderrTail。不会自动重试（重试要重新确认，避免重复计费）。',
  }
}

/** 组装计划 + 令牌 + 预览文本；preview 与 render 共用同一套组装逻辑。 */
function assemblePlan(root, taskEntry, args) {
  const manifest = loadManifest(root).manifest
  const step = args.step ?? 'whole'
  const base = resolveBasePrompt(root, taskEntry, step, manifest, args.rawPrompt)
  if (!base.text) {
    return {
      ok: false,
      plan: null,
      errors: [`拿不到基础提示词：${base.reason ?? '未知原因'}。可以用 rawPrompt 直接给出基础提示词正文。`],
      warnings: [],
    }
  }
  const raw = buildRenderPlan({
    root,
    task: taskEntry.id,
    taskDirName: taskEntry.title ?? path.basename(taskEntry.textsDir ?? ''),
    basePrompt: base.text,
    basePromptSource: base.source,
    model: args.model ?? null,
    requirements: {
      style: args.style ?? null,
      size: args.size ?? null,
      quality: args.quality ?? null,
      background: args.background ?? null,
      extra: args.extra ?? null,
      avoid: args.avoid ?? null,
      palette: args.palette ?? null,
      panels: args.panels ?? null,
      label: args.label ?? null,
      model: args.model ?? null,
    },
    step,
    inputImage: args.inputImage ?? defaultInputImage(root, taskEntry, step),
  })
  if (!raw.plan) return { ok: false, plan: null, errors: raw.errors, warnings: raw.warnings }
  const token = planToken(raw.plan)
  return { ok: raw.ok, plan: raw.plan, token, preview: formatPreview(raw.plan, token), errors: raw.errors, warnings: raw.warnings }
}

// ─────────────────────────────── fetch（下载参考素材）───────────────────────────────

async function fetchReport(root, args) {
  const parsed = resolveBundles(args.bundles)
  if (parsed.errors.length > 0) {
    return { ok: false, action: 'fetch', root, errors: parsed.errors }
  }
  const bundles = parsed.ids
  try {
    const result = await fetchReferenceAssets({ root, bundleIds: bundles, write: args.write === true })
    return {
      ok: result.ok !== false,
      action: 'fetch',
      root,
      dryRun: result.dryRun,
      wrote: result.wrote,
      upstream: result.upstream,
      bundles,
      perBundle: result.perBundle,
      fileCount: result.fileCount,
      totalBytes: result.totalBytes,
      totalBytesHuman: result.totalBytesHuman,
      downloaded: result.downloaded ?? null,
      failures: result.failures ?? [],
      sourceFile: result.sourceFile ?? null,
      sampleFiles: result.files.slice(0, 20),
      instruction: result.dryRun
        ? '这是 dry-run：只列了会下载什么，没有写盘。确认后用 write=true 才会下载（只往 datas/ 写）。'
        : '已下载并写入 datas/。来源与许可记录见 sourceFile；上游是 CC BY-NC-SA 4.0。',
    }
  } catch (error) {
    return {
      ok: false,
      action: 'fetch',
      root,
      error: `${error.message}。上游是 GitHub 公开仓库 ${'EDMOK/blue-fish-archive'}；若提示速率受限，可设 GH_TOKEN 环境变量提高额度。`,
      bundles,
    }
  }
}

// ─────────────────────────────── draft（自由需求 → 草稿）───────────────────────────────

function draftReport(args) {
  const narrative = String(args.narrative ?? args.requirement ?? '').trim()
  return {
    ok: true,
    action: 'draft',
    narrative: narrative || null,
    template: draftTemplate(narrative),
    checklist: draftChecklist(),
    options: describeOptions(),
    availableBundles: Object.values(BUNDLES).map(bundle => ({
      id: bundle.id, label: bundle.label, dest: bundle.dest, huge: bundle.huge === true,
    })),
    defaultBundles: DEFAULT_BUNDLES,
    instruction:
      '这一步不写文件、不出图。让 LLM 按 template 的结构产出一份草稿（文案由它依需求写，插件不代写），'
      + '再调 draftCheck 校验。校验通过后返回完整草稿供用户逐字修改。',
  }
}

function draftCheckReport(args) {
  const result = checkDraft(args.draft)
  if (!result.ok) {
    return {
      ok: false,
      action: 'draftCheck',
      errors: result.errors,
      warnings: result.warnings,
      fingerprint: result.fingerprint,
      instruction: '改完再调一次 draftCheck。这一步不写文件、不出图。',
    }
  }
  const texts = draftToTextsFiles(result.draft)
  return {
    ok: true,
    action: 'draftCheck',
    draft: result.draft,
    requirements: result.requirements,
    rendered: renderDraft(result.draft, { fingerprint: result.fingerprint }),
    fingerprint: result.fingerprint,
    storyboardPreview: texts.storyboard,
    storyboardSha256: texts.storyboardSha256,
    warnings: result.warnings,
    instruction:
      '把 rendered 给用户逐字复核。改动后重新 draftCheck（指纹会变）。'
      + '确认无误再走 scaffold 建任务并写入 00_分镜与文案锁定.md，然后 build、preview。',
  }
}

// ─────────────────────────────── commands ───────────────────────────────

function commandsReport(root, task, args, tasks) {
  const step = args.step ? String(args.step) : null
  if (!step) {
    return {
      ok: true,
      action: 'commands',
      root,
      steps: Object.keys(TASK_COMMANDS),
      python: resolvePython(),
      instruction: '用 step 参数取某一步的逐字命令。所有文本走 --prompt-file，禁止在 pwsh 里内联中文。',
    }
  }
  if (!TASK_COMMANDS[step]) {
    return { ok: false, action: 'commands', error: `未知 step：${step}；可用：${Object.keys(TASK_COMMANDS).join(', ')}` }
  }
  const selected = task ?? matchTask(tasks, args.task) ?? tasks[0] ?? null
  const built = buildCommandStep(step, {
    root,
    task: selected?.id ?? 'taskNN',
    taskDirName: selected?.title ?? 'taskNN_简短中文标题',
    model: args.model ?? null,
    quality: args.quality ?? null,
    size: args.size ?? null,
    background: args.background ?? null,
  })
  return {
    ok: true,
    action: 'commands',
    root,
    step,
    task: selected?.id ?? null,
    model: built.model,
    modelProfile: built.model ? MODEL_PROFILES[built.model] ?? null : null,
    caveats: built.caveats,
    commands: built.commands,
  }
}
