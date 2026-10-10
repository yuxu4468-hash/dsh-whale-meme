/**
 * dsh-whale-meme / natural —— 把用户说的话翻译成参数值。
 *
 * 为什么单独一层：原来所有参数都要求**精确枚举值**（`style: "watercolor"`、`size: "1024x1024"`、
 * `quality: "xhigh"`、`background: "transparent"`）。这对调用方是负担，也让人没法直接说需求 ——
 * 「换成水彩」「要方的」「透明底」「高清一点」都是最自然的表达，却全部会被拒。
 *
 * 本模块把这些说法规范成枚举值，并**如实报告它把话理解成了什么**。
 * 拿不准的一律返回 null（不猜），解析结果一律进 `notes` 让用户看见并可纠正。
 *
 * 三条设计规则：
 *   1. **保守匹配**：宁可返回 null 让人补一句，也不要猜错一个值 —— 猜错尺寸/档位的代价是一次付费出图。
 *   2. **可解释**：每个映射都说明「原文 → 取值」，进回复让用户能一眼反驳。
 *   3. **不覆盖显式值**：已经给了合法枚举值就不再翻译。
 *
 * @module dsh-whale-meme/natural
 */

import { MODEL_PROFILES } from './core.mjs'
import { ALLOWED_SIZES, STYLE_PRESETS } from './requirements.mjs'

/** 去掉全角空格与首尾空白，用于匹配。 */
const clean = value => String(value ?? '').trim().replace(/\s+/g, ' ')

/** 精确 id 或标签命中即返回，否则 null。用于「先试原样」。 */
function exactFrom(map, raw) {
  const text = clean(raw)
  if (map[text]) return map[text]
  const lower = text.toLowerCase()
  for (const [key, value] of Object.entries(map)) {
    if (key.toLowerCase() === lower) return value
  }
  return null
}

/** 关键词表：按顺序取第一个命中的。 */
function byKeyword(pairs, raw) {
  const text = clean(raw).toLowerCase()
  if (!text) return null
  for (const [pattern, value] of pairs) {
    if (pattern.test(text)) return value
  }
  return null
}

// ─────────────────────────── 画风 ───────────────────────────

/** 中文说法 → 预设 id。 */
const STYLE_ALIASES = [
  [/赛璐|cel|日系|动画风|动漫风|二次元/, 'anime-cel'],
  [/贴纸|表情包风|chibi|q版贴纸|Q版贴纸/i, 'chibi-sticker'],
  [/水彩|水粉|手绘|晕染/, 'watercolor'],
  [/扁平|矢量|flat|无描边|极简/, 'flat-vector'],
  [/像素|pixel|点阵/, 'pixel-art'],
  [/复古|90年代|九十年代|retro|怀旧/, 'retro-anime-90s'],
]

/**
 * 解析画风。命中不到时返回 null，并把原文当「自定义画风描述」用（更自由，不报错）。
 * @returns {{style: string|null, customStyle: string|null, note: string|null}}
 */
export function parseStyle(raw) {
  const text = clean(raw)
  if (!text) return { style: null, customStyle: null, note: null }

  // 1) 原样命中 id 或标签
  if (STYLE_PRESETS[text]) return { style: text, customStyle: null, note: `画风「${text}」命中预设 ${STYLE_PRESETS[text].label}` }
  const byLabel = Object.values(STYLE_PRESETS).find(preset => preset.label === text)
  if (byLabel) return { style: byLabel.id, customStyle: null, note: `画风「${text}」命中预设 ${byLabel.label}` }

  // 2) 中文/英文说法
  const keyword = byKeyword(STYLE_ALIASES, text)
  if (keyword) {
    return { style: keyword, customStyle: null, note: `画风「${text}」→ 预设 ${STYLE_PRESETS[keyword].label}（${keyword}）` }
  }

  // 3) 都认不出：当自定义画风描述，不报错（这是「减少限制」的那一半）
  return { style: null, customStyle: text, note: `画风「${text}」没有对应预设，已当作自定义画风描述直接拼进提示词` }
}

// ─────────────────────────── 尺寸 ───────────────────────────

const SIZE_ALIASES = [
  [/^(方|方的|方形|正方形|正方)$/, '1024x1024'],
  [/1\s*[:：]\s*1|一比一/, '1024x1024'],
  [/竖版|竖向|竖构图|portrait|上下|两格|双格/, '1024x1536'],
  [/4\s*[:：]\s*3|四比三/, '1024x768'],
  [/横版|横向|横构图|landscape|宽屏/, '1536x1024'],
]

/**
 * 解析尺寸。支持「方的」「竖版」「4:3」以及任何 `1024x1536` 这类字面量。
 * @returns {{size: string|null, note: string|null}}
 */
export function parseSize(raw) {
  const text = clean(raw)
  if (!text) return { size: null, note: null }

  const literal = text.toLowerCase().replace(/[×*]/g, 'x').replace(/\s/g, '')
  if (ALLOWED_SIZES.includes(literal)) {
    return { size: literal, note: literal === text ? null : `尺寸「${text}」→ ${literal}` }
  }
  // 「1024 乘 1536」这类中文说法
  const chinese = /(\d{3,4})\s*[乘x×]\s*(\d{3,4})/.exec(text)
  if (chinese) {
    const candidate = `${chinese[1]}x${chinese[2]}`
    if (ALLOWED_SIZES.includes(candidate)) return { size: candidate, note: `尺寸「${text}」→ ${candidate}` }
  }

  const keyword = byKeyword(SIZE_ALIASES, text)
  if (keyword) return { size: keyword, note: `尺寸「${text}」→ ${keyword}` }
  return { size: null, note: null }
}

// ─────────────────────────── 质量档 ───────────────────────────

const QUALITY_ALIASES = [
  [/^low$|低|草稿|快速|省点|省着点|凑合|能用就行/i, 'low'],
  // 锚定开头：「中等偏上」不该被当成 medium（「中」出现在词中不算命中）
  [/^中(等|档|档位)?$|^标准$|^medium$/i, 'medium'],
  [/极高|最高|最高质|超清|顶级|xhigh|拉满档/i, 'xhigh'],
  [/顶配|极致|拉满|max|最好/i, 'max'],
  [/高清|精细|高质|高质量|^高$|high/i, 'high'],
]

/**
 * 解析质量档。
 *
 * 注意：中文程度词（「高清」「精细」）与英文档位不一一对应 —— `high` 之上还有 `xhigh`/`max`。
 * 所以命中程度词时**会给出提醒**，让用户知道这是推断、可以改。
 * @returns {{quality: string|null, note: string|null}}
 */
export function parseQuality(raw) {
  const text = clean(raw)
  if (!text) return { quality: null, note: null }

  const lower = text.toLowerCase()
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(lower)) {
    return { quality: lower, note: lower === text ? null : `质量档「${text}」→ ${lower}` }
  }
  const keyword = byKeyword(QUALITY_ALIASES, text)
  if (keyword) return { quality: keyword, note: `质量档「${text}」→ ${keyword}（程度词的对应关系是推断的，可直接指定 low/medium/high/xhigh/max）` }
  return { quality: null, note: null }
}

// ─────────────────────────── 背景 ───────────────────────────

const BACKGROUND_ALIASES = [
  // 顺序 + 否定词都要照顾到：「不透明」「不要透明」里都含「透明」，先挡住它们，
  // 否则会把 opaque 需求翻成 transparent（翻反了会白出一张图）。
  [/不透明|不要透明|不用透明|别透明|不要抠图|不抠图|纯白|白底|灰白底|实底|opaque/i, 'opaque'],
  [/透明|抠图|alpha|transparent/i, 'transparent'],
]

/** @returns {{background: string|null, note: string|null}} */
export function parseBackground(raw) {
  const text = clean(raw)
  if (!text) return { background: null, note: null }
  const lower = text.toLowerCase()
  if (['opaque', 'transparent'].includes(lower)) {
    return { background: lower, note: lower === text ? null : `背景「${text}」→ ${lower}` }
  }
  const keyword = byKeyword(BACKGROUND_ALIASES, text)
  if (keyword) return { background: keyword, note: `背景「${text}」→ ${keyword}` }
  return { background: null, note: null }
}

// ─────────────────────────── 模型 ───────────────────────────

const MODEL_ALIASES = [
  [/sunburst|2\.5\s*sun|太阳/, 'gpt-image-2.5-sunburst'],
  [/flare|2\.5\s*flare|耀/, 'gpt-image-2.5-flare'],
  [/2\.5/, 'gpt-image-2.5-sunburst'],
  [/^(gpt-image-2|二|老模型|旧模型|原来的模型|gpt image 2)$/i, 'gpt-image-2'],
]

/** @returns {{model: string|null, note: string|null}} */
export function parseModel(raw) {
  const text = clean(raw)
  if (!text) return { model: null, note: null }
  if (MODEL_PROFILES[text]) return { model: text, note: null }
  const keyword = byKeyword(MODEL_ALIASES, text)
  if (keyword) return { model: keyword, note: `模型「${text}」→ ${MODEL_PROFILES[keyword].label}（${keyword}）` }
  return { model: null, note: null }
}

// ─────────────────────────── 步骤 ───────────────────────────

const STEP_ALIASES = [
  [/母图|立绘|母版|基准图|第\s*0\s*步/, 'mother'],
  [/上格|第一格|上面那格|上半/, 'upper'],
  [/下格|第二格|下面那格|下半/, 'lower'],
  [/整图|一张图|整幅|一次出图|完整图|不分格/, 'whole'],
]

/** @returns {{step: string|null, note: string|null}} */
export function parseStep(raw) {
  const text = clean(raw)
  if (!text) return { step: null, note: null }
  if (['mother', 'upper', 'lower', 'whole'].includes(text.toLowerCase())) {
    return { step: text.toLowerCase(), note: null }
  }
  const keyword = byKeyword(STEP_ALIASES, text)
  if (keyword) return { step: keyword, note: `步骤「${text}」→ ${keyword}` }
  return { step: null, note: null }
}

// ─────────────────────────── 格数 ───────────────────────────

const PANEL_ALIASES = [
  [/单格|一格|一张|1\s*格|不分格|不要分格/, 1],
  [/两格|二格|双格|上下两格|2\s*格|上下格/, 2],
  [/三格|3\s*格/, 3],
  [/四格|4\s*格|四格漫画/, 4],
  [/六格|6\s*格/, 6],
]

/** @returns {{panels: number|null, note: string|null}} */
export function parsePanels(raw) {
  if (raw === undefined || raw === null || raw === '') return { panels: null, note: null }
  const asNumber = Number(raw)
  if (Number.isInteger(asNumber) && asNumber >= 1) {
    return { panels: asNumber, note: null }
  }
  const text = clean(raw)
  const keyword = byKeyword(PANEL_ALIASES, text)
  if (keyword) return { panels: keyword, note: `格数「${text}」→ ${keyword} 格` }
  return { panels: null, note: null }
}

// ─────────────────────────── 任务号 ───────────────────────────

const ORDINALS = new Map([
  ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4], ['五', 5],
  ['六', 6], ['七', 7], ['八', 8], ['九', 9], ['十', 10],
])

/**
 * 解析任务选择器：`task01`、`01`、`1`、`第一个`、「第一个任务」都可以。
 * 只做**纯语法**翻译（不去查任务是否存在），存在性交给调用方按工作区校验。
 * @returns {{taskId: string|null, note: string|null}}
 */
export function parseTask(raw) {
  const text = clean(raw)
  if (!text) return { taskId: null, note: null }

  // 已经是 taskNN 形式
  const already = /^task(\d{1,3})$/i.exec(text)
  if (already) return { taskId: `task${already[1].padStart(2, '0')}`, note: null }

  // 纯数字
  const digits = /^(\d{1,3})$/.exec(text)
  if (digits) {
    const id = `task${digits[1].padStart(2, '0')}`
    return { taskId: id, note: `任务「${text}」→ ${id}` }
  }

  // 第N个 / 第N个任务 / N号
  const ordinal = /第?\s*([一二两三四五六七八九十]|\d{1,3})\s*(个|号|个任务)?/.exec(text)
  if (ordinal) {
    const token = ordinal[1]
    const index = /^\d+$/.test(token) ? Number(token) : ORDINALS.get(token)
    if (index) {
      const id = `task${String(index).padStart(2, '0')}`
      return { taskId: id, note: `任务「${text}」→ ${id}` }
    }
  }
  return { taskId: null, note: null }
}

// ─────────────────────────── 一次性翻译 ───────────────────────────

/**
 * 把一组自然语言参数翻译成规范取值。
 *
 * 只翻译**认得出**的字段；认不出的一律保持原值不动（交给后面的严格校验去报错，
 * 这样既不会静默吞掉错误，也不会因为翻译层而放宽真正的约束）。
 *
 * @param {object} args - 原始参数
 * @returns {{args: object, notes: string[]}}
 */
export function parseNatural(args = {}) {
  const out = { ...args }
  const notes = []
  const put = (field, value, note) => {
    if (value === null || value === undefined) return
    if (note) notes.push(note)
    out[field] = value
  }

  // 画风：命中预设就换成 id；认不出时保留原文，由 normalizeRequirements 当自定义画风
  if (args.style !== undefined && args.style !== null && String(args.style).trim() !== '') {
    const parsed = parseStyle(args.style)
    if (parsed.style) put('style', parsed.style, parsed.note)
    else if (parsed.customStyle) {
      // 保持原文不动（requirements 会把它当自定义画风），但要把「我这么理解了」说出来
      notes.push(parsed.note)
    }
  }

  if (args.size !== undefined && args.size !== null && String(args.size).trim() !== '') {
    const parsed = parseSize(args.size)
    put('size', parsed.size, parsed.note)
  }
  if (args.quality !== undefined && args.quality !== null && String(args.quality).trim() !== '') {
    const parsed = parseQuality(args.quality)
    put('quality', parsed.quality, parsed.note)
  }
  if (args.background !== undefined && args.background !== null && String(args.background).trim() !== '') {
    const parsed = parseBackground(args.background)
    put('background', parsed.background, parsed.note)
  }
  if (args.model !== undefined && args.model !== null && String(args.model).trim() !== '') {
    const parsed = parseModel(args.model)
    put('model', parsed.model, parsed.note)
  }
  if (args.step !== undefined && args.step !== null && String(args.step).trim() !== '') {
    const parsed = parseStep(args.step)
    put('step', parsed.step, parsed.note)
  }
  if (args.panels !== undefined && args.panels !== null && args.panels !== '') {
    const parsed = parsePanels(args.panels)
    put('panels', parsed.panels, parsed.note)
  }
  // 任务号：只认「第N个 / N号 / 纯数字」这类明确说法；认不出就原样交给工作区去匹配
  if (args.task !== undefined && args.task !== null && String(args.task).trim() !== '') {
    const raw = String(args.task)
    // 已经像 taskNN 或包含标题的，不要动
    if (!/^task/i.test(raw) && /第|号|^\d+$/.test(raw)) {
      const parsed = parseTask(raw)
      put('task', parsed.taskId, parsed.note)
    }
  }

  return { args: out, notes }
}

/** 汇总「自然语言里没认出来的值」，供回复如实告知。 */
export function unresolvedNatural(args = {}) {
  const checks = [
    ['画风', args.style, () => parseStyle(args.style).style !== null],
    ['尺寸', args.size, () => parseSize(args.size).size !== null],
    ['质量档', args.quality, () => parseQuality(args.quality).quality !== null],
    ['背景', args.background, () => parseBackground(args.background).background !== null],
    ['模型', args.model, () => parseModel(args.model).model !== null],
    ['步骤', args.step, () => parseStep(args.step).step !== null],
  ]
  const out = []
  for (const [label, value, ok] of checks) {
    if (value === undefined || value === null || String(value).trim() === '') continue
    if (!ok()) out.push(`${label}「${value}」没能识别成有效取值`)
  }
  return out
}
