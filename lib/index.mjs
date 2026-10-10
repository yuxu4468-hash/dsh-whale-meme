/**
 * dsh-whale-meme —— 把「蓝色大肥鱼」表情包工作区（F:\whale meme）的工作流固化为 DSH 插件。
 *
 * 本插件做三件事，全部是「加装」而不是「改写」：
 *   1. 注册 `whale_meme` 工具：工作区全景、单任务逐字文案、负载逐字一致性、产物血缘、产物机械自检、
 *      每一步的逐字复现命令、新任务骨架。除 scaffold write 外全部只读。
 *   2. 注册 `whale-meme-workflow` 技能：完整工作流正文（资产在 assets/skill/ 下，可随技能读取）。
 *   3. 加载时把工作流契约追加到工作区上下文（角色剪影三要素 / 目录归属 / 硬规则），
 *      让「这个工作区怎么工作」不再依赖会话记忆。
 *
 * 不修改工作区里的任何文件（包括 _tools/ 下的脚本）。卸载即恢复原状。
 *
 * @module dsh-whale-meme
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildContract, resolveWorkspaceRoot } from './core.mjs'
import { ACTIONS, TOOL_DESCRIPTION, TOOL_NAME, WRITING_ACTIONS, runWhaleMeme } from './tools.mjs'

/** Cordis 插件名。 */
export const name = 'whale-meme'

/**
 * 需要宿主提供的注册表。
 *
 * **刻意不把 `subprocess` 放进来**：它是 render 出图才需要的可选能力。
 * 若列为必需，宿主一旦没有该服务，整个插件会保持 pending —— 连只读的校验工具都装不上，
 * 这比「出图不可用」糟糕得多。所以 subprocess 由 makeSpawner 在装载时探测，
 * 探测不到就只让 render 明确拒绝执行，其余 action 照常可用。
 */
export const inject = ['tools', 'skills']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ASSET_ROOT = path.resolve(HERE, '..', 'assets', 'skill')
const SKILL_DIR = path.join(ASSET_ROOT, 'whale-meme-workflow')
const SKILL_FILE = path.join(SKILL_DIR, 'SKILL.md')

/** 技能名（catalog 与调用名）。 */
export const SKILL_NAME = 'whale-meme-workflow'

/** 读取技能正文（含 YAML frontmatter，便于人工核对）。 */
function readSkillContent() {
  return readFileSync(SKILL_FILE, 'utf8')
}

/**
 * 取技能的自述片段：description / 正文首段标题。
 * 技能描述由上游目录数据提供，这里只做兜底。
 */
export function skillSummary() {
  const raw = readSkillContent()
  const description = /^description:\s*(.+)$/m.exec(raw)?.[1]?.trim() ?? '「蓝色大肥鱼」表情包工作区的固定绘制工作流。'
  const whenToUse = /^description:\s*(.+)$/m.exec(raw)?.[1]?.trim() ?? description
  return { description, whenToUse }
}

/**
 * 把工作流契约追加到工作区上下文。
 *
 * 宿主版本之间的入口名不同，这里按「一次性方法调用」逐个探测，最后才退化为回调形式；
 * 任何一个都不存在时只记录一条 debug，不影响工具与技能（契约内容同时也内嵌在技能正文里）。
 */
async function appendWorkspaceContract(ctx, root, contract) {
  const workspace = ctx.workspace
  if (!workspace) return false
  const attempts = [
    () => workspace.appendInstructions?.(contract, { root }),
    () => workspace.appendInstructions?.(contract),
    () => workspace.addInstructions?.(root, contract),
    () => workspace.appendContext?.({ root, text: contract }),
    () => workspace.appendSystemPrompt?.(contract),
    () => workspace.injectInstructions?.(root, contract),
    () => workspace.append?.(root, contract),
  ]
  for (const attempt of attempts) {
    try {
      const result = attempt()
      if (result === undefined || result === null) continue
      if (typeof result?.then === 'function') {
        const settled = await result
        if (settled !== false && settled !== undefined) return true
        continue
      }
      if (result !== false) return true
    } catch {
      // 换下一个入口
    }
  }
  // 回调式注册（cordis 的 ctx.inject 风格）
  if (typeof workspace.instructions === 'function') {
    try {
      workspace.instructions(root, contract)
      return true
    } catch {
      return false
    }
  }
  return false
}

/**
 * 把宿主的子进程能力适配成 render 需要的 `spawn({program,args,cwd,timeoutMs})` 形状。
 *
 * 宿主是 `ctx.subprocess.spawn`（cordis 契约），本机实测的 DSH 与 dsh-vision-toolkit
 * 都走这个入口；找不到时返回 undefined，render 会明确拒绝执行而不会静默失败。
 */
/**
 * 工具结果的显示方式：有自然语言回复就显示回复，否则退回 JSON。
 *
 * 宿主契约是 `(args, value) => ContentBlock[]`（与 vision 工具一致）。
 */
function renderResult(_args, value) {
  const reply = value && typeof value === 'object' ? value.reply : null
  if (typeof reply === 'string' && reply.trim() !== '') {
    return [{ type: 'text', text: reply }]
  }
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function makeSpawner(ctx) {  const subprocess = ctx.subprocess
  if (subprocess && typeof subprocess.spawn === 'function') {
    return async ({ program, args, cwd, timeoutMs }) => {
      try {
        const handle = subprocess.spawn({ program, args, cwd, timeoutMs })
        // 宿主句柄的字段名在不同版本间可能不同，逐个探测；都没有就退化为「只等退出码」
        const outcome = typeof handle?.wait === 'function' ? await handle.wait() : await handle
        const code = outcome?.exitCode ?? outcome?.code ?? handle?.exitCode ?? null
        const stdout = outcome?.stdout ?? handle?.stdout ?? ''
        const stderr = outcome?.stderr ?? handle?.stderr ?? ''
        return { code: typeof code === 'number' ? code : null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }
      } catch (error) {
        return { code: null, stdout: '', stderr: `subprocess.spawn 失败：${error.message}` }
      }
    }
  }
  ctx.logger?.debug?.('whale-meme: 宿主没有 subprocess.spawn，render 将拒绝执行出图（可用 commands 拿命令自行执行）')
  return undefined
}

/**
 * 装载插件。
 * @param {object} ctx - Cordis 上下文（含 tools / skills / workspace / logger）。
 * @param {{root?: string|null, injectWorkspaceContract?: boolean, registerSkill?: boolean, contractMaxChars?: number}} [config]
 */
export async function apply(ctx, config = {}) {
  const settings = {
    root: config.root ?? null,
    injectWorkspaceContract: config.injectWorkspaceContract !== false,
    registerSkill: config.registerSkill !== false,
    contractMaxChars: Number.isFinite(config.contractMaxChars) ? config.contractMaxChars : 6000,
  }

  // 工作区定位失败不应该让插件装载失败：工具会在每次调用时重新解析并给出可读的错误。
  let resolved = null
  try {
    resolved = resolveWorkspaceRoot({ root: settings.root })
    ctx.logger?.info?.(`whale-meme: 工作区 = ${resolved.root}（${resolved.how}）`)
  } catch (error) {
    ctx.logger?.warn?.(`whale-meme: ${error.message}`)
  }
  const workspaceRoot = resolved?.root ?? settings.root ?? null
  const spawn = makeSpawner(ctx)

  // 1) 工具
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    ctx.tools.register({
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      parameters: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: '要执行的动作：status / task / payload / lineage / outputs / commands / scaffold / init / preview / build / render / fetch / draft / draftCheck。前六个只读；scaffold、init、build、fetch 默认 dry-run（write=true 才落盘）；render 还需 confirm=true + 令牌。',
        },
        task: { type: 'string', description: '任务选择器，例如 task01、01 或 task01_字符串替换把脚本改坏了。不传时若工作区只有一个任务则自动选中。' },
        step: { type: 'string', description: 'commands 用：build / mother / upper / lower / whole / compose / check / index。preview 与 render 用：whole / mother / upper / lower。不传时 commands 列清单、preview 默认 whole。' },
        model: { type: 'string', description: '目标模型：gpt-image-2、gpt-image-2.5-sunburst 或 gpt-image-2.5-flare。缺省按步骤给推荐值。' },
        quality: { type: 'string', description: '质量档：low / medium / high / xhigh / max。缺省用该模型推荐档（2.5 Sunburst 为 xhigh）。' },
        size: { type: 'string', description: '画布尺寸：1024x1024 / 1024x1536 / 1024x768 / 1536x1024。缺省按 step 与画风推导。' },
        background: { type: 'string', description: 'opaque 或 transparent。transparent 只对 gpt-image-2.5 系有效，gpt-image-2 会被拒绝。' },
        style: { type: 'string', description: '画风预设 id：anime-cel（日系 Q 版赛璐璐，默认）/ chibi-sticker（Q 版贴纸单格）/ watercolor（水彩）/ flat-vector（扁平矢量）/ pixel-art（像素画）/ retro-anime-90s（90 年代复古）。也可传自定义画风描述文本。' },
        extra: { type: 'array', items: { type: 'string' }, description: '文本之外的附加要求，例如「尾鳍不要有白斑」。会以追加段落的形式拼进提示词，不改动基础提示词正文。' },
        avoid: { type: 'array', items: { type: 'string' }, description: '要避免出现的内容，例如「第二个人物」。两个图像模型都没有负向词参数，所以会被改写成正向句子。' },
        palette: { type: 'array', items: { type: 'string' }, description: '配色要求，例如「深藏青为主」「只用 4 色」。' },
        panels: { type: 'integer', description: '分格数，只能是 1 或 2（本项目实测结论：叙事最多上下两格）。' },
        label: { type: 'string', description: '产出文件名的附加标签，会成为文件名的一部分（不能含路径分隔符）。' },
        rawPrompt: { type: 'string', description: '仅 preview / render 用：直接给出基础提示词正文，跳过从 texts/ 定位。一般不需要。' },
        inputImage: { type: 'string', description: '仅 preview / render 用：edit 端点的输入图绝对路径。缺省时 mother 用参考立绘、upper 用母图、lower 用上格。' },
        confirm: { type: 'boolean', description: '仅 render 用：必须显式传 true 才会真的出图；不传则只返回计划。出图每张按张计费。' },
        token: { type: 'string', description: '仅 render 用：preview 返回的确认令牌，原样带回。一次性、10 分钟有效、计划改动即失效。' },
        title: { type: 'string', description: '仅 scaffold 用：新任务的简短中文标题，会成为目录名 texts/taskNN_<标题>。' },
        number: { type: 'integer', description: '仅 scaffold 用：指定任务号；不传则取现有最大号 +1。' },
        write: { type: 'boolean', description: '仅 scaffold / init / build / fetch 用：默认 false（dry-run，只报告计划）；传 true 才真正写盘。init 只创建缺失项、不覆盖；fetch 只往 datas/ 写。' },
        withReadme: { type: 'boolean', description: '仅 init 用：是否在缺失时创建工作区根 README.md，默认 true。' },
        bundles: {
          type: 'array',
          items: { type: 'string' },
          description: '仅 fetch 用：要下载哪些素材包 —— character（立绘+logo）/ samples（样例与图库清单）/ previews（251 张缩略图）/ large / media，或传 ["all"]。缺省 character+samples+previews（约 17 MB）。media 约 242 MB，慎用。',
        },
        narrative: { type: 'string', description: '仅 draft 用：用户的原话需求，一句或一段都行。插件不写文案，只把它带进模板供 LLM 依此产出。' },
        draft: { type: 'object', additionalProperties: true, description: '仅 draftCheck 用：LLM 依 draft 模板产出的草稿对象（narrative/subject/panels/style/size/extra/avoid/palette/model）。校验通过后返回完整草稿供用户逐字复核。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            reply: {
              type: 'string',
              required: true,
              description: '自然语言状态回复：先结论、再数字、最后给下一步。人读这份即可；要细节再读其它结构化字段。',
            },
            ok: { type: 'boolean', required: true },
            action: { type: 'string', required: true },
            root: { type: 'string' },
            error: { type: 'string' },
          },
        },
        // 优先渲染自然语言回复：结构化字段仍在（代理与脚本照常判断），
        // 但默认展示给人看的是一段能直接读的结论，而不是一坨 JSON。
        render: renderResult,
      },
      async execute(args) {
        return runWhaleMeme(args ?? {}, { workspaceRoot, spawn })
      },
      isConcurrencySafe: args => !WRITING_ACTIONS.includes(String(args?.action ?? 'status')),
      presentCall: args => {
        const action = String(args?.action ?? 'status')
        return {
          card: 'generic',
          title: `whale_meme · ${action}${action === 'render' && args?.confirm === true ? '（真出图，计费）' : ''}`,
          kind: WRITING_ACTIONS.includes(action) ? 'execute' : 'read',
          locations: workspaceRoot ? [{ path: workspaceRoot }] : [],
        }
      },
    })
  } else {
    ctx.logger?.warn?.('whale-meme: 宿主没有 tools 注册表，工具未注册')
  }

  // 2) 技能
  if (settings.registerSkill && ctx.skills && typeof ctx.skills.register === 'function') {
    try {
      ctx.skills.register({
        name: SKILL_NAME,
        description: skillSummary().description,
        whenToUse: skillSummary().whenToUse,
        source: 'plugin',
        resourceBase: { kind: 'directory', path: SKILL_DIR },
        content: readSkillContent(),
      })
    } catch (error) {
      ctx.logger?.warn?.(`whale-meme: 技能注册失败：${error.message}`)
    }
  } else if (settings.registerSkill) {
    ctx.logger?.warn?.('whale-meme: 宿主没有 skills 注册表，技能未注册')
  }

  // 3) 工作流契约注入
  if (settings.injectWorkspaceContract && workspaceRoot) {
    try {
      const contract = buildContract(workspaceRoot, { skillName: SKILL_NAME, maxChars: settings.contractMaxChars })
      const appended = await appendWorkspaceContract(ctx, workspaceRoot, contract)
      if (!appended) {
        ctx.logger?.debug?.('whale-meme: 宿主 workspace 没有可用的契约追加入口（契约仍在技能正文里）')
      }
    } catch (error) {
      ctx.logger?.warn?.(`whale-meme: 契约注入失败：${error.message}`)
    }
  }
}

/** 自检入口：给 smoke 测试用，验证资产齐备。 */
export function selfCheck() {
  return {
    plugin: name,
    skillFile: SKILL_FILE,
    skillFileExists: existsSync(SKILL_FILE),
    skillDir: SKILL_DIR,
    assetRoot: ASSET_ROOT,
    actions: ACTIONS,
  }
}
