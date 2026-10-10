/**
 * dsh-whale-meme / draft —— 自由需求 → 整套提示词草稿 → 用户校验。
 *
 * 原来的流程对使用者要求偏高：必须先把 `00_分镜与文案锁定.md` 的逐字文案、加粗位置、
 * 版式参数都定稿，才能往下走。实际使用里人往往只有一句话需求
 * （「她发现脚本被改坏了，先是得意然后破防」），文案是要边想边改的。
 *
 * 所以这一层把「想」和「定」分开：
 *   * `draft`      给一句自然语言需求 → 返回**待填写模板 + 检查清单**，由 LLM 去填；
 *   * `draftCheck` 把填好的草稿拿回来**校验并结构化** → 用户在这里看、改、再确认。
 *
 * 三条设计规则：
 *   1. **本模块不生成文案**。插件不写台词 —— 文案由 LLM 依需求产出，用户逐字校验。
 *      这样「唯一权威文本」仍然是用户确认过的那份，而不是插件猜的。
 *   2. **不落盘**。draft / draftCheck 都是纯计算；要写文件得走 scaffold。
 *   3. **校验从严**：句末全角句号、加粗必须出现在文案里、marker 不重复、尺寸与模型匹配、
 *      合规红线（不得出现「官方」措辞、不得把凭据写进提示词）。
 *
 * @module dsh-whale-meme/draft
 */

import { createHash } from 'node:crypto'

import { MODEL_PROFILES, SILHOUETTE_ANCHORS, sha256 } from './core.mjs'
import { ALLOWED_SIZES, STYLE_PRESETS, normalizeRequirements } from './requirements.mjs'

/** 一屏能读完的模板：字段少、每个字段给示例。 */
export function draftTemplate(narrative) {
  return {
    narrative: String(narrative ?? '').trim(),
    subject: '<这个任务要讲的梗是什么？一句话>',
    panels: [
      { marker: '格 1（上格）', text: '<第一格台词，句末用全角句号。>', mood: '<情绪，例如：自信满满>' },
      { marker: '格 2（下格）', text: '<第二格台词，句末用全角句号。>', mood: '<情绪反转，例如：当场破防>', bold: '<必须加粗的字，没有就留空>' },
    ],
    style: Object.keys(STYLE_PRESETS)[0],
    size: '1024x1536',
    quality: null,
    background: null,
    extra: [],
    avoid: [],
    palette: [],
  }
}

/** 校验清单：LLM 按此填写，用户按此检查。 */
export function draftChecklist() {
  return [
    '每格台词**原样照抄进提示词**，一个字都不能改：不加标点、不加说话人、不加标题。',
    '句末必须是中文全角句号「。」，不是英文句点、不是感叹号、不是省略号。',
    '`bold` 里写的字**必须逐字出现在该格文案里**，且只有这些字加粗。',
    '格数不设上限：一格贴纸、三四格连环都可以；超过两格时请确认尺寸排得下。',
    '`background: transparent` 只对 gpt-image-2.5 系有效；gpt-image-2 会被直接拒绝。',
    '「不要什么」写进 avoid，插件会改写成正向句子（两个模型都没有负向词参数）。',
    '不得出现「官方」「官方授权」措辞；不得把凭据、密钥写进任何字段。',
    '这条需求如果要长期留存，应当先落进 00_分镜与文案锁定.md 再出图 —— 否则产物无法追溯。',
  ]
}

/**
 * 校验 LLM 填好的草稿。
 * @returns {{ok: boolean, errors: string[], warnings: string[], draft: object|null, requirements: object|null}}
 */
export function checkDraft(input) {
  const errors = []
  const warnings = []
  const raw = input ?? {}

  const narrative = String(raw.narrative ?? '').trim()
  if (!narrative) warnings.push('没有给 narrative（原始需求）。建议保留，便于日后追溯这版文案是怎么来的。')

  const subject = String(raw.subject ?? '').trim()
  if (!subject) errors.push('缺少 subject：一句话说明这个任务要讲的梗')
  if (/^<.*>$/.test(subject)) errors.push('subject 还是模板占位符，没有真正填写')
  if (!subject) errors.push('subject 不能为空')

  // ── 分格与逐字文案 ──────────────────────────────
  const panelsRaw = raw.panels
  if (!Array.isArray(panelsRaw) || panelsRaw.length === 0) {
    errors.push('panels 必须是至少一个元素的数组')
  }
  const panels = Array.isArray(panelsRaw) ? panelsRaw : []
  // 格数不设上限：一格贴纸、三格连环、四格漫画都允许；超过两格只提醒尺寸可能排不下
  if (panels.length > 2) {
    warnings.push(`草稿有 ${panels.length} 格：格数不设限，但可用的尺寸档最多按上下两格排版（1024x1536）。`
      + '格数更多时请确认尺寸够不够，必要时指定 size。')
  }

  const seenMarkers = new Set()
  panels.forEach((panel, index) => {
    const where = `第 ${index + 1} 格`
    const text = String(panel?.text ?? '').trim()
    if (!text) { errors.push(`${where} 缺少 text（逐字台词）`); return }
    if (/^<.*>$/.test(text)) errors.push(`${where} 的 text 还是模板占位符`)
    if (/[。！？!?]$/.test(text) === false) errors.push(`${where} 的台词没有以句末标点结尾：${text}`)
    if (/[.,;:]/.test(text)) warnings.push(`${where} 的台词里有半角标点，请确认是刻意的：${text}`)
    if (/[a-zA-Z]{2,}/.test(text)) warnings.push(`${where} 的台词里有连续英文字母，中文文案通常不该有：${text}`)

    const marker = String(panel?.marker ?? '').trim()
    if (!marker) warnings.push(`${where} 没有 marker，建议写成「格 N（上/下格）」`)
    else if (seenMarkers.has(marker)) errors.push(`marker 重复：${marker}`)
    else seenMarkers.add(marker)

    const bold = panel?.bold === undefined || panel?.bold === null ? '' : String(panel.bold).trim()
    if (bold) {
      // 加粗必须真的出现在文案里 —— 否则模型无从加粗，这是最常见的「写了但没生效」
      if (!text.includes(bold)) errors.push(`${where} 的 bold「${bold}」没有出现在台词里：${text}`)
      if (bold.length > text.length) errors.push(`${where} 的 bold 比整句还长`)
    }
  })

  // ── 非文本要求复用既有校验 ───────────────────────
  const styleInput = raw.style === undefined || raw.style === null || raw.style === '' ? null : String(raw.style).trim()
  const sizeInput = raw.size === undefined || raw.size === null || raw.size === '' ? null : String(raw.size).trim()
  const requirementCheck = normalizeRequirements({
    style: styleInput,
    size: sizeInput,
    quality: raw.quality ?? null,
    background: raw.background ?? null,
    extra: raw.extra ?? null,
    avoid: raw.avoid ?? null,
    palette: raw.palette ?? null,
    panels: panels.length > 0 ? panels.length : null,
    model: raw.model ?? null,
  })
  errors.push(...requirementCheck.errors)
  warnings.push(...requirementCheck.warnings)
  const requirements = requirementCheck.requirements

  // 透明底与模型匹配
  if (requirements.background === 'transparent') {
    const model = raw.model && MODEL_PROFILES[raw.model] ? raw.model : 'gpt-image-2.5-sunburst'
    if (!MODEL_PROFILES[model].transparentBackground) {
      errors.push(`${MODEL_PROFILES[model].label} 不支持透明底；要透明请改用 gpt-image-2.5-sunburst`)
    }
  }

  // ── 合规红线 ────────────────────────────────────
  const allText = [subject, ...panels.map(panel => String(panel?.text ?? '')), ...(requirements.extra ?? []), ...(requirements.avoid ?? [])].join('\n')
  if (/官方(授权|出品|正版)?/.test(allText)) {
    errors.push('文案或要求里出现「官方」字样：本项目是非官方同人，验收清单 E 组明确禁止')
  }

  const ok = errors.length === 0
  const draft = {
    narrative,
    subject,
    panels: panels.map((panel, index) => ({
      marker: String(panel?.marker ?? `格 ${index + 1}`).trim(),
      text: String(panel?.text ?? '').trim(),
      mood: panel?.mood ? String(panel.mood).trim() : null,
      bold: panel?.bold ? String(panel.bold).trim() : null,
    })),
    style: requirements.style,
    customStyle: requirements.customStyle,
    size: requirements.size ?? (panels.length === 1 ? '1024x1024' : '1024x1536'),
    quality: requirements.quality,
    background: requirements.background,
    extra: requirements.extra,
    avoid: requirements.avoid,
    palette: requirements.palette,
    model: raw.model && MODEL_PROFILES[raw.model] ? raw.model : 'gpt-image-2.5-sunburst',
  }

  // 指纹：用户改了草稿之后能看出「和刚才校验的不是同一份」
  const fingerprint = createHash('sha256').update(JSON.stringify(draft, Object.keys(draft).sort()), 'utf8').digest('hex')

  return { ok, errors, warnings, draft: ok ? draft : null, requirements, fingerprint }
}

/**
 * 把校验通过的草稿渲染成可复核的文本（用户在这里看、改、再确认）。
 */
export function renderDraft(draft, { fingerprint } = {}) {
  const lines = []
  lines.push(`【文案草稿】${draft.subject}`)
  lines.push('')
  if (draft.narrative) {
    lines.push('原始需求：')
    lines.push(`  ${draft.narrative}`)
    lines.push('')
  }
  lines.push('逐字文案（这几个字会被原样画进图里，请逐字校对）：')
  for (const panel of draft.panels) {
    lines.push(`  [${panel.marker}] ${panel.text}`)
    if (panel.mood) lines.push(`        情绪：${panel.mood}`)
    if (panel.bold) lines.push(`        加粗：${panel.bold}`)
  }
  lines.push('')
  lines.push('出图参数：')
  lines.push(`  模型      ${draft.model}`)
  lines.push(`  画风      ${draft.style ?? (draft.customStyle ? `自定义（${draft.customStyle}）` : '未指定，沿用基础提示词')}`)
  lines.push(`  尺寸      ${draft.size}`)
  if (draft.quality) lines.push(`  质量档    ${draft.quality}`)
  if (draft.background) lines.push(`  背景      ${draft.background}`)
  if (draft.palette.length > 0) lines.push(`  配色      ${draft.palette.join('；')}`)
  if (draft.extra.length > 0) lines.push(`  附加要求  ${draft.extra.join('；')}`)
  if (draft.avoid.length > 0) lines.push(`  禁止项    ${draft.avoid.join('；')}`)
  lines.push('')
  lines.push(`角色剪影三要素（不得丢失）：${SILHOUETTE_ANCHORS.join('；')}`)
  if (fingerprint) {
    lines.push('')
    lines.push(`草稿指纹  ${fingerprint.slice(0, 12)}`)
  }
  return lines.join('\n')
}

/** 草稿 → 建议写入 texts/ 的内容（供 scaffold 用；这里只算，不写盘）。 */
export function draftToTextsFiles(draft) {
  const storyboardLines = [
    `# ${draft.subject}`,
    '',
    '> 由 whale_meme(action="draft") 草稿生成，**必须人工校验后**才视为定稿。',
    draft.narrative ? `> 原始需求：${draft.narrative}` : null,
    '',
    '## 1. 逐字文案（原样复制，含加粗）',
    '',
    '```text',
  ].filter(line => line !== null)

  for (const panel of draft.panels) {
    storyboardLines.push(panel.marker)
    storyboardLines.push(panel.text)
    storyboardLines.push('')
    if (panel.bold) {
      storyboardLines.push(`（仅「${panel.bold}」加粗）`)
      storyboardLines.push('')
    }
  }
  storyboardLines.push('```', '')
  const storyboard = `${storyboardLines.join('\n')}\n`

  return {
    storyboard,
    storyboardSha256: sha256(storyboard),
  }
}

/** 供工具层做参数校验用。 */
export function describeOptions() {
  return {
    styles: Object.values(STYLE_PRESETS).map(preset => ({ id: preset.id, label: preset.label })),
    sizes: [...ALLOWED_SIZES],
    models: Object.keys(MODEL_PROFILES),
  }
}
