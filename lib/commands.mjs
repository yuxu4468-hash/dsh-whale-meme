/**
 * dsh-whale-meme / commands —— 工作流每一步的「逐字复现命令」生成器。
 *
 * 只生成字符串，不执行任何命令：出图是有费用、有副作用的动作，
 * 必须由代理在明确知道自己在做什么的时候自己发起。
 *
 * @module dsh-whale-meme/commands
 */

import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ENVIRONMENT_RULES, MODEL_PROFILES } from './core.mjs'

/** 工作区自带工具及其职责（只读引用，脚本本体不属于本插件）。 */
export const WORKSPACE_TOOLS = Object.freeze([
  { file: '_tools/whale_image_client.py', role: '出图客户端：gen（文生图）/ edit（图生图），自动重试、立即下载、写元数据', mutable: false },
  { file: '_tools/build_payloads.py', role: '从 texts/ 逐字抽取投喂负载到 _tools/payloads/<task>/，带断言防索引错位', mutable: false },
  { file: '_tools/compose_panels.py', role: '两格拼合（1024x1536 / 1024x2072，格间 24 px、外框 4 px）', mutable: false },
  { file: '_tools/check_outputs.py', role: '机械自检：尺寸、模式、alpha、灰度 stddev、近白占比、sha256', mutable: false },
  { file: '_tools/build_outs_index.py', role: '重建 outs/INDEX.csv', mutable: false },
])

/** 角色参考立绘（编辑链第 0 步的输入）。 */
export const CHARACTER_SHEET = 'datas/01_character/原始立绘_deepseek_whale.png'

/** 可用的 step 及其说明。 */
export const TASK_COMMANDS = Object.freeze({
  build: '从 texts/ 逐字抽取投喂负载到 _tools/payloads/<task>/ 并重建索引',
  mother: '编辑链第 0 步：立绘 → 2~3 头身 Q 版中性站姿母图（锁角色身份，不能省）',
  upper: '编辑链第 1 步：母图 → 上格（只改场景/表情/屏幕/气泡）',
  lower: '编辑链第 2 步：上格 → 下格（单变量编辑，锁死角色与机位）',
  whole: '方案 A：一次出 1024x1536 整图（不经过编辑链）',
  compose: '本地拼合两格为 1024x1536 / 1024x2072（无 API 费用）',
  check: '机械自检出图目录，写 checks.json',
  index: '重建 outs/INDEX.csv',
})

/**
 * 找可用的 Python 解释器，按下面顺序取第一个真实存在的：
 *   1. 环境变量 DSH_WHALE_PYTHON（显式指定，优先级最高）
 *   2. DSH_HOME 下的自带运行时（默认 %USERPROFILE%\.dsh）
 *   3. PATH 里的 python
 * 不写死任何绝对路径，换机器不用改代码。
 */
export function resolvePython() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const candidates = [
    process.env.DSH_WHALE_PYTHON,
    path.join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    path.join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'bin', 'python3'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return 'python'
}

/** PowerShell 单引号字符串转义（路径里可能有空格与中文）。 */
function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function joinPath(root, ...parts) {
  return parts.length === 0 ? root : `${root.replace(/[\\/]+$/, '')}\\${parts.join('\\')}`
}

/**
 * 生成某一步的逐字命令。
 * @param {string} step - TASK_COMMANDS 的键。
 * @param {{root: string, task: string, taskDirName?: string, model?: string|null, quality?: string|null, size?: string|null, background?: string|null}} input
 * @returns {{model: string|null, commands: string[], caveats: string[]}}
 */
export function buildCommandStep(step, input) {
  const { root, task, taskDirName = 'taskNN_简短中文标题' } = input
  const python = resolvePython()
  const py = quote(python)
  const tool = file => quote(joinPath(root, ...file.split('/')))
  const payload = file => quote(joinPath(root, '_tools', 'payloads', task, file))
  const textsDir = joinPath(root, 'texts', taskDirName)
  const model = resolveModel(input.model, step)
  const profile = model ? MODEL_PROFILES[model] : null
  if (model && !profile) {
    return {
      model,
      modelProfile: null,
      commands: [],
      caveats: [`未知模型 "${model}"；已知：${Object.keys(MODEL_PROFILES).join(', ')}`],
    }
  }
  const quality = input.quality ?? profile?.defaultQuality ?? 'high'
  const caveats = []
  /** 统一出口：保证每个 step 都带 modelProfile，调用方不需要再查表。 */
  const result = (modelId, commands, extraCaveats = []) => ({
    model: modelId,
    modelProfile: modelId ? MODEL_PROFILES[modelId] ?? null : null,
    caveats: [...caveats, ...extraCaveats],
    commands,
  })

  switch (step) {
    case 'build':
      return result(null, [`& ${py} ${tool('_tools/build_payloads.py')}`], [
        'build_payloads.py 里的任务路径目前是 task01 的字面量：换任务时必须先改脚本顶部的 TASK/OUT 常量，再运行。',
        '抽取后务必用 whale_meme(action="payload") 核验 status 全为 ok。',
      ])

    case 'mother':
      return result(model, [
        `& ${py} ${tool('_tools/whale_image_client.py')} edit`
        + ` --model ${model}`
        + ` --prompt-file ${payload('10_母图_中性站姿.txt')}`
        + ` --image ${quote(joinPath(root, ...CHARACTER_SHEET.split('/')))}`
        + ` --out ${quote(joinPath(root, 'outs', taskDirName, model, '01_母图_中性站姿_1024.png'))}`
        + ` --size 1024x1024 --quality ${quality} --timeout 900`,
      ], [
        '第 0 步不能省：立绘是成熟比例，直接用立绘做后两格的输入会继承御姐比例（违反验收清单 B8）。',
        `参考图：${CHARACTER_SHEET}`,
      ])

    case 'upper':
      return result(model, [
        `& ${py} ${tool('_tools/whale_image_client.py')} edit`
        + ` --model ${model}`
        + ` --prompt-file ${payload('11_上格_编辑.txt')}`
        + ` --image ${quote(joinPath(root, 'outs', taskDirName, model, '01_母图_中性站姿_1024.png'))}`
        + ` --out ${quote(joinPath(root, 'outs', taskDirName, model, '02_上格_自信_1024.png'))}`
        + ` --size 1024x1024 --quality ${quality} --timeout 900`,
      ], [
        '输入图是母图（不是立绘）：只改场景、表情、屏幕内容、气泡，锁死角色与机位。',
        '一次画两格是本任务角色漂移的最大原因 —— 不要用整图提示词代替这一步。',
      ])

    case 'lower':
      return result(model, [
        `& ${py} ${tool('_tools/whale_image_client.py')} edit`
        + ` --model ${model}`
        + ` --prompt-file ${payload(isLegacyImage2(model) ? '12_下格_编辑__img2.txt' : '12_下格_编辑__img25.txt')}`
        + ` --image ${quote(joinPath(root, 'outs', taskDirName, model, '02_上格_自信_1024.png'))}`
        + ` --out ${quote(joinPath(root, 'outs', taskDirName, model, '03_下格_破防_1024.png'))}`
        + ` --size 1024x1024 --quality ${quality} --timeout 900`,
      ], [
        '下格按模型分开措辞：gpt-image-2 用 12_下格_编辑__img2.txt，2.5 系用 12_下格_编辑__img25.txt。',
        '单变量编辑：只改表情/姿态/屏幕内容/漫画符号。',
      ])

    case 'whole': {
      const backgroundFlag = input.background ? ` --background ${input.background}` : ''
      return result(model, [
        `& ${py} ${tool('_tools/whale_image_client.py')} gen`
        + ` --model ${model}`
        + ` --prompt-file ${payload(isLegacyImage2(model) ? '20_整图__img2.txt' : '21_整图__img25.txt')}`
        + ` --out ${quote(joinPath(root, 'outs', taskDirName, model, '05_整图一次出图_1024x1536.png'))}`
        + ` --size 1024x1536 --quality ${quality}${backgroundFlag} --timeout 900`,
      ], [
        '方案 A（一次出整图）与编辑链互为备选：编辑链更稳，整图更快但角色漂移风险高。',
        ...(profile && !profile.transparentBackground
          ? [`${profile.label} 出图固定为不透明底；要透明贴纸请改用 gpt-image-2.5-sunburst + --background transparent。`]
          : []),
        ...(input.background === 'transparent' && profile?.transparentBackground
          ? ['透明底只在 PNG/WebP 下有效，且仅 gpt-image-2.5 系支持。']
          : []),
      ])
    }

    case 'compose': {
      const composeModel = model ?? 'gpt-image-2.5-sunburst'
      return result(null, [
        `& ${py} ${tool('_tools/compose_panels.py')}`
        + ` --top ${quote(joinPath(root, 'outs', taskDirName, composeModel, '02_上格_自信_1024.png'))}`
        + ` --bottom ${quote(joinPath(root, 'outs', taskDirName, composeModel, '03_下格_破防_1024.png'))}`
        + ` --out-dir ${quote(joinPath(root, 'outs', taskDirName, composeModel))}`
        + ` --prefix 04_拼合 --focus top`,
      ], [
        '必须 --focus top：单格气泡在画面上部，默认 center 裁切会把气泡首行裁掉（本项目首版即踩此坑）。',
        '拼合是纯本地操作，不产生 API 费用，可以反复重跑。',
      ])
    }

    case 'check':
      return result(null, [
        `& ${py} ${tool('_tools/check_outputs.py')}`
        + ` --dir ${quote(joinPath(root, 'outs', taskDirName, model ?? 'gpt-image-2'))}`
        + ` --dir ${quote(joinPath(root, 'outs', taskDirName, 'gpt-image-2.5-sunburst'))}`
        + ` --out ${quote(joinPath(root, 'outs', taskDirName, 'checks.json'))}`,
      ], [
        'check_outputs.py 只做机械检查（尺寸/可解码/非空白），不能替代 04_验收清单.md 的人眼逐字验收。',
      ])

    case 'index':
      return result(null, [`& ${py} ${tool('_tools/build_outs_index.py')}`], [
        'build_outs_index.py 的 ROOT 目前写死为 outs/ 目录字面量，换机器需改脚本常量。',
      ])

    default:
      return result(model, [], [`未知 step：${step}`, ...ENVIRONMENT_RULES])
  }
}

/** 是否是不支持透明底、且下格/整图负载单独成文的第一代 gpt-image-2。 */
function isLegacyImage2(model) {
  return model === 'gpt-image-2'
}

function resolveModel(model, step) {
  if (model) return model
  const fallback = step === 'whole' || step === 'mother' || step === 'upper' || step === 'lower'
    ? 'gpt-image-2.5-sunburst'
    : 'gpt-image-2'
  return fallback
}

/** 供 skill 正文引用的环境坑清单。 */
export function environmentChecklist() {
  return ENVIRONMENT_RULES.map((rule, index) => `${index + 1}. ${rule}`).join('\n')
}
