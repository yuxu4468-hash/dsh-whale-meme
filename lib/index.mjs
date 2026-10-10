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
import { ACTIONS, TOOL_DESCRIPTION, TOOL_NAME, runWhaleMeme } from './tools.mjs'

/** Cordis 插件名。 */
export const name = 'whale-meme'

/** 需要宿主提供的注册表；缺任何一个插件保持 pending，不半残注册。 */
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

  // 1) 工具
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    ctx.tools.register({
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      parameters: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: '要执行的检查：status（工作区全景）/ task（单任务逐字文案与文件）/ payload（负载逐字一致性）/ lineage（产物血缘）/ outputs（产物机械自检）/ commands（逐字复现命令）/ scaffold（新建任务骨架）。除 scaffold 写盘外全部只读。',
        },
        task: { type: 'string', description: '任务选择器，例如 task01、01 或 task01_字符串替换把脚本改坏了。不传时若工作区只有一个任务则自动选中。' },
        step: { type: 'string', description: '仅 commands 用：build / mother / upper / lower / whole / compose / check / index。不传则返回可用步骤清单。' },
        model: { type: 'string', description: '仅 commands 用：gpt-image-2、gpt-image-2.5-sunburst 或 gpt-image-2.5-flare。缺省按步骤给推荐值。' },
        quality: { type: 'string', description: '仅 commands 用：low / medium / high / xhigh / max。缺省用该模型推荐档。' },
        size: { type: 'string', description: '仅 commands 用：如 1024x1024、1024x1536。' },
        background: { type: 'string', description: '仅 commands 用：opaque 或 transparent（transparent 只对 gpt-image-2.5 系有效）。' },
        title: { type: 'string', description: '仅 scaffold 用：新任务的简短中文标题，会成为目录名 texts/taskNN_<标题>。' },
        number: { type: 'integer', description: '仅 scaffold 用：指定任务号；不传则取现有最大号 +1。' },
        write: { type: 'boolean', description: '仅 scaffold 用：默认 false（dry-run，只报告计划）；传 true 才真正创建文件。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
            action: { type: 'string', required: true },
            root: { type: 'string' },
            error: { type: 'string' },
          },
        },
      },
      async execute(args) {
        return runWhaleMeme(args ?? {}, { workspaceRoot })
      },
      isConcurrencySafe: args => args?.action !== 'scaffold' || args?.write !== true,
      presentCall: args => ({
        card: 'generic',
        title: `whale_meme · ${args?.action ?? 'status'}`,
        kind: 'read',
        locations: workspaceRoot ? [{ path: workspaceRoot }] : [],
      }),
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
