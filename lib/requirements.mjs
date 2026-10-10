/**
 * dsh-whale-meme / requirements —— 「文本之外的要求」与提示词组装。
 *
 * 工作流原本只有一件事可调：文案（`00_分镜与文案锁定.md`）。但实际出图还有一堆非文本要求：
 * 画风、尺寸与版式、质量档、透明底、配色、附加要求（比如「尾鳍不要白斑」）、禁止项。
 * 本模块把它们规范化，并组装成一份**可预览、可校验**的出图计划。
 *
 * 两条硬约束：
 *   1. **不重写基础提示词**。风格与附加要求一律以「追加段落」的形式加在既有提示词之后，
 *      原始文本保持逐字不动 —— 这样预览里能一眼看出改了什么，而不是把原文搅碎。
 *   2. **两个图像模型都没有独立的负向提示词字段**。所以「禁止项」必须写成自然语言的
 *      正向句子（「画面中不要出现……，请确保……」），不能当成负向词表塞进去。
 *
 * @module dsh-whale-meme/requirements
 */

import { createHash } from 'node:crypto'
import path from 'node:path'

import { MODEL_PROFILES, SILHOUETTE_ANCHORS, sha256, trimEdges } from './core.mjs'

/**
 * 画风预设。每个预设给出可直接拼进提示词的中文句子，以及它强制/默认的尺寸。
 * 只放本工作区真用得上的风格，不做成通用风格库。
 */
export const STYLE_PRESETS = Object.freeze({
  'anime-cel': {
    id: 'anime-cel',
    label: '日系 Q 版赛璐璐',
    directive: '画风：日系 Q 版动画赛璐璐上色。清晰的深色描边、平涂色块加分块阴影，不要写实光影、不要厚涂、不要 3D 渲染感。',
    size: '1024x1536',
    notes: '工作区既有产物的默认风格，与参考语料一致。',
  },
  'chibi-sticker': {
    id: 'chibi-sticker',
    label: 'Q 版贴纸（单格）',
    directive: '画风：Q 版贴纸插画。单角色居中、无分格、轮廓干净，适合缩小到 240×240 仍看得清五官与手势。',
    size: '1024x1024',
    sticky: true,
    notes: '需要透明贴纸时配合 background: transparent。',
  },
  watercolor: {
    id: 'watercolor',
    label: '柔和手绘水彩',
    directive: '画风：柔和手绘水彩。轻微纸纹、边缘自然晕开、颜色清淡透明；保持角色辨识特征，不要变成写实人像。',
  },
  'flat-vector': {
    id: 'flat-vector',
    label: '扁平矢量',
    directive: '画风：扁平矢量插画。极简几何形状、无描边或统一细描边、纯色块，不要渐变噪点、不要纹理。',
  },
  'pixel-art': {
    id: 'pixel-art',
    label: '像素画',
    directive: '画风：像素画。明显的方形像素格、受限调色板、硬边无抗锯齿；不要出现半透明羽化或模糊渐变。',
    size: '1024x1024',
    notes: '缩小到 240×240 时像素风本就清晰，但中文文字在像素风下极易糊 —— 建议走无字底图 + 后期排版。',
  },
  'retro-anime-90s': {
    id: 'retro-anime-90s',
    label: '90 年代复古动画',
    directive: '画风：90 年代复古赛璐璐动画。略偏暖的配色、较粗的外轮廓、可见的胶片颗粒感；五官比例仍保持 2~3 头身 Q 版，不要拉成写实比例。',
  },
})

/** 允许的尺寸（本项目实测可用档）。 */
export const ALLOWED_SIZES = Object.freeze(['1024x1024', '1024x1536', '1024x768', '1536x1024'])

/** 尺寸 → 版式说明，便于拼进提示词。 */
const SIZE_DIRECTIVES = Object.freeze({
  '1024x1024': '正方形 1024 × 1024（单格或贴纸）',
  '1024x1536': '竖版 1024 × 1536（上下两格，各 1024 × 768）',
  '1024x768': '横版 1024 × 768（单格横构图）',
  '1536x1024': '横版 1536 × 1024（单格横构图）',
})

/** 附加要求的敏感词：这些不是「画风要求」，而是不该由插件代答的东西。 */
const REFUSED_PATTERNS = [
  { pattern: /api[\s_-]?key|token|凭据|密钥|密码/i, reason: '不能把凭据或密钥写进提示词' },
  { pattern: /官方授权|官方出品|official/i, reason: '本项目是非官方同人，不得出现「官方」措辞（见验收清单 E 组）' },
]

/**
 * 规范化「文本之外的要求」。
 * @param {object} raw - 用户/代理给的要求对象，字段都可选。
 * @returns {{ok: boolean, errors: string[], warnings: string[], requirements: object}}
 */
export function normalizeRequirements(raw = {}) {
  const errors = []
  const warnings = []
  const input = raw ?? {}

  // 画风
  let style = null
  const styleInput = input.style ?? input.artStyle ?? null
  if (styleInput) {
    const key = String(styleInput).trim()
    if (STYLE_PRESETS[key]) style = key
    else if (/[\u4e00-\u9fa5]|^[a-z][a-z\s-]{3,}$/i.test(key)) {
      warnings.push(`没找到预设画风「${key}」，已当作自定义画风描述处理。可用预设：${Object.keys(STYLE_PRESETS).join(', ')}`)
      style = null
    } else {
      errors.push(`画风「${key}」无法识别。可用预设：${Object.keys(STYLE_PRESETS).join(', ')}`)
    }
  }

  // 尺寸
  let size = input.size ? String(input.size).trim().toLowerCase().replace('×', 'x') : null
  if (size && !ALLOWED_SIZES.includes(size)) {
    errors.push(`尺寸「${size}」不在允许档内：${ALLOWED_SIZES.join(', ')}`)
  }
  if (!size && style && STYLE_PRESETS[style].size) size = STYLE_PRESETS[style].size

  // 质量档
  const quality = input.quality ? String(input.quality).trim().toLowerCase() : null
  const modelForQuality = input.model && MODEL_PROFILES[input.model] ? input.model : null
  if (quality && modelForQuality && !MODEL_PROFILES[modelForQuality].qualities.includes(quality)) {
    errors.push(`模型 ${modelForQuality} 不支持质量档「${quality}」；支持：${MODEL_PROFILES[modelForQuality].qualities.join(', ')}`)
  }
  if (quality && !['low', 'medium', 'high', 'xhigh', 'max'].includes(quality)) {
    errors.push(`质量档「${quality}」不存在；支持：low / medium / high / xhigh / max`)
  }

  // 透明底
  let background = input.background ? String(input.background).trim().toLowerCase() : null
  if (background && !['opaque', 'transparent'].includes(background)) {
    errors.push(`背景只能是 opaque 或 transparent，收到「${background}」`)
  }

  // 附加要求 / 禁止项 / 配色 / 备注
  const asTextList = (value, label) => {
    if (value === undefined || value === null) return []
    const list = Array.isArray(value) ? value : [value]
    const out = []
    for (const item of list) {
      const text = String(item ?? '').trim()
      if (text === '') continue
      const refused = REFUSED_PATTERNS.find(entry => entry.pattern.test(text))
      if (refused) {
        errors.push(`${label}「${text.slice(0, 40)}」被拒绝：${refused.reason}`)
        continue
      }
      out.push(text)
    }
    return out
  }

  const extra = asTextList(input.extra ?? input.requirements ?? input.notes, '附加要求')
  const avoid = asTextList(input.avoid ?? input.prohibitions, '禁止项')
  const palette = asTextList(input.palette ?? input.colors, '配色')
  // panels：null / undefined 都表示「没指定」，只有真给了数字才校验
  const panelsRaw = input.panels
  const panels = panelsRaw === undefined || panelsRaw === null ? null : Number(panelsRaw)
  if (panels !== null && (!Number.isInteger(panels) || panels < 1 || panels > 2)) {
    errors.push('本项目实测结论：叙事最多做上下两格（参考语料与验收清单），panels 只能是 1 或 2')
  }

  const label = input.label ? String(input.label).trim() : null
  if (label && (label.includes('/') || label.includes('\\') || /[<>:"|?*]/.test(label))) {
    errors.push('label 会成为文件名的一部分，不能含路径分隔符与 <>:"|?* 这些字符')
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    requirements: {
      style,
      customStyle: style === null && styleInput ? String(styleInput).trim() : null,
      size,
      quality,
      background,
      extra,
      avoid,
      palette,
      panels,
      label,
    },
  }
}

/** 由要求推导「这份出图计划应该产出什么文件」。 */
export function deriveOutputs(requirements, { panel = null } = {}) {
  const size = requirements.size ?? '1024x1536'
  const background = requirements.background ?? null
  const transparent = background === 'transparent'
  const suffix = transparent ? '_透明' : ''
  const outputs = []

  if (size === '1024x1536') {
    outputs.push({ role: '整图（上下两格）', file: `05_整图一次出图_1024x1536${suffix}.png`, size, background })
  } else if (size === '1024x1024') {
    outputs.push({ role: '单格贴纸', file: `06_单格_1024x1024${suffix}.png`, size, background })
  } else {
    outputs.push({ role: '单格', file: `06_单格_${size.replace('x', 'x')}${suffix}.png`, size, background })
  }
  if (panel === 'mother') outputs[0].file = `01_母图_中性站姿_1024${suffix}.png`
  if (panel === 'upper') outputs[0].file = `02_上格_自信_1024${suffix}.png`
  if (panel === 'lower') outputs[0].file = `03_下格_破防_1024${suffix}.png`
  return outputs
}

/** 生成「文本之外的要求」追加段；没有要求时返回空串。 */
export function buildRequirementsSection(requirements) {
  const lines = []
  const preset = requirements.style ? STYLE_PRESETS[requirements.style] : null
  if (preset) lines.push(preset.directive)
  if (requirements.customStyle) lines.push(`画风：${requirements.customStyle}。`)

  if (requirements.size && SIZE_DIRECTIVES[requirements.size]) {
    lines.push(`画布与版式：${SIZE_DIRECTIVES[requirements.size]}。`)
  }
  if (requirements.panels === 1) lines.push('只要一格，不要分格线，不要上下拼版。')
  if (requirements.panels === 2) lines.push('上下两格等分，格间留 24 px 纯白间隙，外沿 4 px 深藏青细边框。')

  if (requirements.background === 'transparent') {
    lines.push('背景：真正的透明 alpha 通道（不要白色方块、不要灰色棋盘格、不要渐变底），导出 PNG 且保留透明通道。')
  } else if (requirements.background === 'opaque') {
    lines.push('背景：统一的纯净浅灰白平涂（约 #F7F8FA），无渐变、无杂物、无场景元素。')
  }

  if (requirements.palette.length > 0) {
    lines.push(`配色：${requirements.palette.join('；')}。`)
  }
  if (requirements.extra.length > 0) {
    lines.push('附加要求：')
    for (const item of requirements.extra) lines.push(`- ${item}`)
  }
  if (requirements.avoid.length > 0) {
    // 两个模型都没有负向词字段，所以写成正向句子
    lines.push('以下内容必须避免出现（本模型没有负向词参数，所以请把这些当作正向约束严格遵守）：')
    for (const item of requirements.avoid) lines.push(`- 画面中不要出现${item}；如果可能，请改为更合适的画法。`)
  }

  if (lines.length === 0) return ''
  return ['', '---', '【本次出图的非文本要求（以上主提示词保持不变，以下为追加约束）】', ...lines].join('\n')
}

/**
 * 组装一份出图计划的提示词正文。
 *
 * 设计要点：**原提示词逐字保留**，要求以追加段落的形式加在后面。
 * 这样预览里能直接看出「加了什么」，也便于用 sha256 记录「这次到底喂了什么」。
 */
export function assemblePrompt({ basePrompt, requirements, characterSheetNote = true }) {
  const body = trimEdges(basePrompt)
  const section = buildRequirementsSection(requirements)
  const head = characterSheetNote
    ? [`角色剪影三要素（不得丢失）：${SILHOUETTE_ANCHORS.join('；')}。`, ''].join('\n')
    : ''
  return `${head}${body}${section}\n`
}

/**
 * 组装完整出图计划。纯函数：不落盘、不发请求，所以可以放心预览与测试。
 *
 * @param {object} input
 * @param {string} input.root - 工作区根目录
 * @param {string} input.task - 任务号（taskNN）
 * @param {string} input.taskDirName - 任务目录名（taskNN_标题）
 * @param {string} input.basePrompt - 基础提示词正文（逐字）
 * @param {string} input.basePromptSource - 基础提示词的来源说明
 * @param {string} [input.model] - 目标模型
 * @param {object} [input.requirements] - 非文本要求
 * @param {string} [input.step] - mother / upper / lower / whole
 * @param {string} [input.inputImage] - edit 端点的输入图（绝对路径）
 * @returns {{ok: boolean, errors: string[], warnings: string[], plan: object|null}}
 */
export function buildRenderPlan(input) {
  // quality / size / background 允许写在顶层，也允许写在 requirements 里。
  // 两类调用方（commands 风格与 preview 风格）都能用，且不会有「传了却被静默忽略」的坑。
  const merged = {
    ...input.requirements,
    model: input.model,
    quality: input.requirements?.quality ?? input.quality ?? null,
    size: input.requirements?.size ?? input.size ?? null,
    background: input.requirements?.background ?? input.background ?? null,
  }
  const { ok, errors, warnings, requirements } = normalizeRequirements(merged)
  const model = input.model && MODEL_PROFILES[input.model] ? input.model : 'gpt-image-2.5-sunburst'
  const profile = MODEL_PROFILES[model]
  const step = input.step ?? 'whole'
  const localErrors = [...errors]
  const localWarnings = [...warnings]

  if (!MODEL_PROFILES[input.model]) {
    if (input.model) localErrors.push(`未知模型「${input.model}」；可用：${Object.keys(MODEL_PROFILES).join(', ')}`)
  }
  if (!['mother', 'upper', 'lower', 'whole'].includes(step)) {
    localErrors.push(`step 只能是 mother / upper / lower / whole，收到「${step}」`)
  }
  if (requirements.background === 'transparent' && !profile.transparentBackground) {
    localErrors.push(`${profile.label} 不支持透明底（网关固定回传 opaque）；要透明请改用 gpt-image-2.5-sunburst 或后期抠图`)
  }
  if (step !== 'whole' && !input.inputImage) {
    localErrors.push(`step=${step} 走 /images/edits，必须提供 inputImage（${step === 'mother' ? '参考立绘' : '上一步的产物'}）`)
  }

  const quality = requirements.quality ?? profile.defaultQuality
  if (!profile.qualities.includes(quality)) {
    localErrors.push(`${profile.label} 不支持质量档「${quality}」；支持：${profile.qualities.join(', ')}`)
  }

  const prompt = assemblePrompt({
    basePrompt: input.basePrompt ?? '',
    requirements,
    characterSheetNote: step === 'whole' || step === 'mother',
  })
  if (!prompt.trim()) localErrors.push('组装后的提示词是空的')

  const outputs = deriveOutputs(requirements, { panel: step === 'whole' ? null : step })
  const outDir = path.join(input.root, 'outs', input.taskDirName, model)
  const promptText = prompt
  const plan = {
    task: input.task,
    taskDirName: input.taskDirName,
    step,
    model,
    modelLabel: profile.label,
    endpoint: step === 'whole' ? profile.endpointGeneration : profile.endpointEdit,
    quality,
    size: requirements.size ?? (step === 'whole' ? '1024x1536' : '1024x1024'),
    background: requirements.background ?? (profile.transparentBackground ? null : 'opaque'),
    inputImage: input.inputImage ?? null,
    outputDir: outDir,
    outputs: outputs.map(output => ({ ...output, absolutePath: path.join(outDir, output.file) })),
    prompt: {
      text: promptText,
      chars: promptText.length,
      sha256: sha256(promptText),
      source: input.basePromptSource ?? null,
      baseSha256: input.basePrompt ? sha256(trimEdges(input.basePrompt)) : null,
    },
    requirements,
    stylePreset: requirements.style ? { id: requirements.style, ...STYLE_PRESETS[requirements.style] } : null,
    estimatedSeconds: quality === 'low' ? '20~40' : quality === 'high' ? '100~130' : '130+',
    notes: [
      '两个图像模型都没有负向提示词参数：禁止项已改写成正向句子。',
      '返回的是约 30 分钟过期的签名 URL，客户端会立即下载。',
      '下载必须带浏览器 User-Agent，否则 Cloudflare 403 error code: 1010（客户端已内置）。',
    ],
  }

  return { ok: localErrors.length === 0, errors: localErrors, warnings: localWarnings, plan }
}

/**
 * 为计划算一个确认令牌：把「这次到底要出什么」的要点压成短哈希。
 * 预览时给出、执行时必须原样带回 —— 保证确认的是**看到的那份**计划。
 */
export function planToken(plan) {
  const material = [
    plan.task,
    plan.step,
    plan.model,
    plan.quality,
    plan.size,
    plan.background ?? '-',
    plan.inputImage ?? '-',
    plan.prompt.sha256,
    plan.outputs.map(output => output.file).join(','),
  ].join('|')
  return createHash('sha256').update(material, 'utf8').digest('hex')
}

/** 把计划渲染成人读预览文本（给对话里看）。 */
export function formatPreview(plan, token) {
  const lines = []
  lines.push(`【出图计划预览】${plan.task} · ${plan.step} · ${plan.modelLabel}`)
  lines.push('')
  lines.push(`端点      ${plan.endpoint}`)
  lines.push(`尺寸      ${plan.size}`)
  lines.push(`质量档    ${plan.quality}`)
  lines.push(`背景      ${plan.background ?? '（不传该字段）'}`)
  if (plan.inputImage) lines.push(`输入图    ${plan.inputImage}`)
  lines.push(`预计耗时  ${plan.estimatedSeconds} 秒/张（本网关实测）`)
  lines.push('')
  lines.push('产出文件：')
  for (const output of plan.outputs) lines.push(`  ${output.role}  →  ${output.absolutePath}`)
  lines.push('')
  const style = plan.stylePreset
  lines.push(`画风      ${style ? `${style.label}（${style.id}）` : '未指定，沿用基础提示词'}`)
  if (plan.requirements.extra.length) lines.push(`附加要求  ${plan.requirements.extra.join('；')}`)
  if (plan.requirements.avoid.length) lines.push(`禁止项    ${plan.requirements.avoid.join('；')}（已改写成正向句子）`)
  if (plan.requirements.palette.length) lines.push(`配色      ${plan.requirements.palette.join('；')}`)
  lines.push('')
  lines.push(`提示词 sha256  ${plan.prompt.sha256}`)
  lines.push(`确认令牌       ${token}`)
  lines.push('')
  lines.push('提示词正文：')
  lines.push('---8<---')
  lines.push(plan.prompt.text.trimEnd())
  lines.push('--->8---')
  return lines.join('\n')
}
