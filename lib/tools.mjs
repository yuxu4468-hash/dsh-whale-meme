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

/** 工具名（模型可见名，必须稳定）。 */
export const TOOL_NAME = 'whale_meme'

/** 工具可见描述。 */
export const TOOL_DESCRIPTION = [
  '「蓝色大肥鱼」表情包工作区的机械校验与复现入口：工作区全景、单任务逐字文案核对、',
  '投喂负载是否仍与 texts/ 逐字一致、产物元数据 prompt.sha256 是否与负载对齐、产物的尺寸与透明通道，',
  '以及每一步的逐字复现命令。所有检查都是只读的，不生成图片、不修改任何文件。',
  `角色剪影三要素：${SILHOUETTE_ANCHORS.join('；')}。`,
].join('')

/** 支持的 action 列表。 */
export const ACTIONS = ['status', 'task', 'payload', 'lineage', 'outputs', 'commands', 'scaffold']

/**
 * 执行一次 whale_meme 调用。
 * @param {object} args - 工具参数（已按 schema 校验）。
 * @param {{env?: Record<string, string|undefined>, cwd?: string, workspaceRoot?: string|null}} [context]
 * @returns {object} 可 JSON 序列化的结果对象。
 */
export function runWhaleMeme(args = {}, context = {}) {
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
  const task = matchTask(tasks, args.task) ?? (tasks.length === 1 ? tasks[0] : null)

  switch (action) {
    case 'status':
      return statusReport(root, tasks)
    case 'task':
      return taskReport(root, task, tasks, args.task)
    case 'payload':
      return payloadReport(root, task, args.task)
    case 'lineage':
      return lineageReport(root, task, args.task)
    case 'outputs':
      return outputsReport(root, task, args.task)
    case 'commands':
      return commandsReport(root, task, args, tasks)
    case 'scaffold':
      return scaffoldReport(root, args)
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
