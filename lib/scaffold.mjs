/**
 * dsh-whale-meme / scaffold —— 新建任务的目录与文件骨架。
 *
 * 工作流里「新建任务只新建 taskNN_* 目录、不改动已有任务」这条规则，
 * 光靠文档约束容易走样；这里给出可复现的骨架，并把角色锚点、编辑链、环境坑、
 * 验收五组一次性写进对应文件。
 *
 * 默认 dry-run：只报告将创建什么，不落盘。要真正创建必须显式 write: true。
 *
 * @module dsh-whale-meme/scaffold
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { ENVIRONMENT_RULES, MODEL_PROFILES, SILHOUETTE_ANCHORS, TASK_FILES, listTasks } from './core.mjs'

/** 每个文件位的角色说明。 */
const FILE_ROLE = {
  storyboard: '唯一权威文本源：逐字文案 + 加粗位置 + 画面设计',
  promptImage2: '投喂 GPT Image 2（含参数、分步工作流、翻车修正）',
  promptImage25: '投喂 GPT Image 2.5（子型号分工、母图编辑流、透明底）',
  textFallback: '中文写错/加粗失效时改走这条，含无字底图与 HTML 排版',
  acceptance: '出图后逐项打勾；A/B 组 FAIL 必须重出',
}

/** 把标题压成可用的目录名片段（去掉路径非法字符）。 */
export function slugify(title) {
  const cleaned = String(title ?? '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '')
    .trim()
  return cleaned.slice(0, 40) || '未命名'
}

/** 下一个可用任务号（按现有 taskNN_* 目录递增）。 */
export function nextTaskNumber(root, explicitNumber) {
  if (Number.isFinite(explicitNumber) && explicitNumber > 0) return Math.floor(explicitNumber)
  const max = listTasks(root).reduce((acc, task) => Math.max(acc, task.number), 0)
  return max + 1
}

/** 任务号 → taskNN。 */
export function taskIdOf(number) {
  return `task${String(number).padStart(2, '0')}`
}

function storyboardTemplate({ taskId, title, panels }) {
  const lines = []
  lines.push(`# ${taskId} · 分镜与文案锁定：${title}`)
  lines.push('')
  lines.push(`> 任务号：**${taskId}** ｜ 锁定日期：${new Date().toISOString().slice(0, 10)} ｜ 写入者：提示词阶段`)
  lines.push('> 题材：（一句话说清梗与人设的关系）')
  lines.push('> 形式：**竖版上下两格漫画**（参考语料明确建议叙事最多做上下两格）')
  lines.push('')
  lines.push('本文件是**唯一权威文本源**。出图时若与本文件的文案、加粗位置、格序有冲突，**一律以本文件为准**，不得即兴改写。')
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('## 1. 逐字文案（原样复制，含加粗）')
  lines.push('')
  lines.push('> 约定：标记行只用于分组；整行的括号只用于写加粗要求；句末必须是中文全角句号「。」。')
  lines.push('')
  lines.push('```text')
  for (const panel of panels) {
    lines.push(panel.marker)
    lines.push(panel.text)
    lines.push('')
    if (panel.note) { lines.push(panel.note); lines.push('') }
  }
  lines.push('```')
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('## 2. 分镜设计')
  lines.push('')
  lines.push('### 格 1（上格）· （情绪）')
  lines.push('')
  lines.push('- **动作**：')
  lines.push('- **情绪**：')
  lines.push('- **表情**：')
  lines.push('- **体态**：')
  lines.push('- **呆毛**：')
  lines.push('- **鲸鳍状耳 / 鲸尾**：')
  lines.push('- **屏幕内容**：只用抽象色块与乱码，不要可读英文长句')
  lines.push('- **道具**：')
  lines.push('')
  lines.push('### 格 2（下格）· （情绪反转）')
  lines.push('')
  lines.push('- **动作**：同一机位、同一书桌、同一角色')
  lines.push('- **情绪**：与格 1 形成强烈反转（这是全图的唯一笑点）')
  lines.push('- **表情 / 体态 / 呆毛 / 鲸鳍状耳 / 鲸尾**：')
  lines.push('- **屏幕内容**：')
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('## 3. 两格之间必须锁死的不变量')
  lines.push('')
  lines.push('出图／编辑时**只允许改变**：表情、姿态、屏幕内容、漫画符号。以下必须逐项保持一致：')
  lines.push('')
  lines.push(`1. 角色剪影三要素：${SILHOUETTE_ANCHORS.join('；')}。`)
  lines.push('2. 服装、配色、机位、景别、光线、背景纯度。')
  lines.push('3. 2~3 头身 Q 版比例（不是成熟御姐比例、不是写实人体）。')
  lines.push('')
  return lines.join('\n')
}

function promptTemplate({ taskId, modelId }) {
  const profile = MODEL_PROFILES[modelId]
  const lines = []
  lines.push(`# ${taskId} · 提示词 · ${profile.label}`)
  lines.push('')
  lines.push(`> 目标模型：\`${modelId}\` ｜ 端点：\`${profile.endpointGeneration}\` / \`${profile.endpointEdit}\``)
  lines.push(`> 质量档：${profile.qualities.join(' / ')}（默认 ${profile.defaultQuality}）｜ 透明底：${profile.transparentBackground ? '支持' : '不支持'}`)
  lines.push(`> ${profile.notes}`)
  lines.push('')
  lines.push('**角色锚点（每次都要写进提示词，不许省略）**')
  lines.push('')
  for (const anchor of SILHOUETTE_ANCHORS) lines.push(`- ${anchor}`)
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('## 1. 参数')
  lines.push('')
  lines.push('| 参数 | 值 |')
  lines.push('|---|---|')
  lines.push(`| model | \`${modelId}\` |`)
  lines.push('| size | `1024x1536`（整图）/ `1024x1024`（单格） |')
  lines.push(`| quality | \`${profile.defaultQuality}\` |`)
  lines.push(`| background | \`${profile.transparentBackground ? 'transparent（要透明贴纸时）' : 'opaque（该模型固定不透明）'}\` |`)
  lines.push('')
  lines.push('## 2. 方案 A：一次出 1024×1536 整图')
  lines.push('')
  lines.push('```text')
  lines.push('（整图主提示词：先角色锚点，再逐格描述画面、气泡文案与加粗、屏幕内容；')
  lines.push('句末标点、加粗范围必须与 00_分镜与文案锁定.md 完全一致，不要增删一个字。）')
  lines.push('```')
  lines.push('')
  lines.push('## 3. 编辑链（推荐，角色最稳）')
  lines.push('')
  lines.push('```text')
  lines.push('第 0 步（母图）：参考图是本角色的唯一身份基准，请锁定同一角色……')
  lines.push('把她画成 1024×1024 的中性站姿全身母图，纯净浅灰白平涂背景，单角色居中……')
  lines.push('不要重新设计角色，不要改服装，不要变成猫娘或普通蓝发女仆。')
  lines.push('```')
  lines.push('')
  lines.push('```text')
  lines.push('第 1 步（上格）：保持这张图里角色完全不变，只把场景改为……；气泡文字为「……」……')
  lines.push('```')
  lines.push('')
  lines.push('```text')
  lines.push('第 2 步（下格）：保持这张图里角色完全不变，只把表情从……改成……，屏幕内容改成……')
  lines.push('```')
  lines.push('')
  lines.push('## 4. 常见翻车与修正')
  lines.push('')
  lines.push('| 现象 | 修正 |')
  lines.push('|---|---|')
  lines.push('| 角色漂移（丢鲸鳍耳 / 鲸尾 / 渐变发色） | 回到编辑链第 0 步重出母图，不要靠整图提示词硬压 |')
  lines.push('| 中文错字 / 加字 / 改标点 | 走 `03_无字底图与后期排版兜底.md`，不要在提示词里反复赌 |')
  lines.push('| 加粗范围错 | 明写「只有「某四字」加粗，其余全部常规字重」 |')
  lines.push('')
  return lines.join('\n')
}

function fallbackTemplate({ taskId }) {
  const lines = []
  lines.push(`# ${taskId} · 无字底图与后期排版兜底`)
  lines.push('')
  lines.push('> **仅在**整图/编辑链的中文连续翻车时启用。模型只画画面（气泡留白），文字后期排。')
  lines.push('')
  lines.push('## 1. 触发条件')
  lines.push('')
  lines.push('- 逐字核对连续 2 次 FAIL（错字、多字、繁体、擅自加标点）。')
  lines.push('- 加粗范围反复不稳定。')
  lines.push('')
  lines.push('## 2. 无字底图提示词')
  lines.push('')
  lines.push('```text')
  lines.push('（画面与 01/02 一致，但所有气泡只画空的圆角矩形留白：')
  lines.push('【气泡留白（关键）】不要在气泡内写任何文字、字母、数字或符号……）')
  lines.push('```')
  lines.push('')
  lines.push('## 3. 后期排版模板（HTML → 截图）')
  lines.push('')
  lines.push('```html')
  lines.push('<!-- 画布 1024 宽；气泡圆角 36px、白底、6px 深藏青描边；字号 56px、行高 1.5、居中 -->')
  lines.push('<!-- 逐字文案从 00_分镜与文案锁定.md 复制，加粗用 <strong>，不要手打 -->')
  lines.push('```')
  lines.push('')
  lines.push('## 4. 验收')
  lines.push('')
  lines.push('后期排版件仍要按 `04_验收清单.md` 的 A 组逐字核对。')
  lines.push('')
  return lines.join('\n')
}

function acceptanceTemplate({ taskId }) {
  const lines = []
  lines.push(`# ${taskId} · 验收清单`)
  lines.push('')
  lines.push('> 用法：出图后**放大到 200%**，按五组逐项打勾。任一项 FAIL 就停，不要进入透明化 / 缩放到 240×240。')
  lines.push('> 文案唯一权威来源：`00_分镜与文案锁定.md` 第 1 节。')
  lines.push('')
  lines.push('## A. 文案与排版（最容易翻车，先查这组）')
  lines.push('')
  lines.push('- [ ] 逐字核对：与 `00_*` 的逐字文案一字不差（多一字少一字都算 FAIL）。')
  lines.push('- [ ] 句末只有中文全角句号「。」，不是英文句点、不是感叹号、不是省略号。')
  lines.push('- [ ] 加粗范围与 `00_*` 完全一致；加粗是**字重变化**，不是描边/外发光/彩色伪造。')
  lines.push('- [ ] 画面里没有多余文字：无引号、无书名号、无说话人姓名、无标题、无英文、无数字、无水印、无签名。')
  lines.push('- [ ] 文字未被裁切；气泡未遮挡面部、鲸鳍状耳、呆毛或鲸尾。')
  lines.push('')
  lines.push('## B. 角色一致性（两格逐个对照）')
  lines.push('')
  for (const [index, anchor] of SILHOUETTE_ANCHORS.entries()) lines.push(`- [ ] B${index + 1} ${anchor}`)
  lines.push('- [ ] B4 白色荷叶边女仆头饰 + 浅蓝小蝴蝶结；白衬衫 + 深藏青金扣马甲 + 白荷叶边围裙。')
  lines.push('- [ ] B5 2~3 头身 Q 版：大头圆脸、鼓脸、短手短脚（不是成熟御姐比例、不是写实人体）。')
  lines.push('- [ ] B6 两格的脸型、发型、发色、服装、配色、机位、景别、光线完全一致（只有表情/姿态/屏幕内容不同）。')
  lines.push('- [ ] B7 画面里只有她一个角色，没有第二个人物、没有真人照片元素。')
  lines.push('')
  lines.push('## C. 分镜与情绪')
  lines.push('')
  lines.push('- [ ] 两格情绪反差一眼可辨：遮住文字也能看出反转。')
  lines.push('- [ ] 屏幕内容为抽象代码/乱码，没有大段可读英文。')
  lines.push('- [ ] 漫画符号适量，没有喧宾夺主。')
  lines.push('')
  lines.push('## D. 技术与输出')
  lines.push('')
  lines.push('- [ ] 画布尺寸正确：整图 1024×1536；单格 1024×1024。')
  lines.push('- [ ] 上下两格等分，格间 24 px 纯白间隙，外沿 4 px 深藏青边框。')
  lines.push('- [ ] 背景为统一纯净浅灰白平涂（约 #F7F8FA），无杂物、无场景元素。')
  lines.push('- [ ] 若走透明贴纸：背景是**真透明 alpha 通道**（不是白块、不是棋盘格、不是渐变底）。')
  lines.push('- [ ] 缩到 240×240 后目视：眼睛、手指、中文、尾鳍细节仍可辨。')
  lines.push('- [ ] 无手部畸形（多指/缺指/手指糊成一团）。')
  lines.push('')
  lines.push('## E. 交付与合规')
  lines.push('')
  lines.push('- [ ] 成品说明写「**非官方同人表情包**」，没有出现「官方」「官方授权」等措辞。')
  lines.push('- [ ] 保留署名入口：角色原作 **上善无形**；女仆鲸鱼娘二次设计 **ZipZipPipe**。')
  lines.push('- [ ] 默认**非商业**、**CC BY-NC-SA 4.0**；未用于售卖/联名/募资。')
  lines.push('- [ ] 未把 `datas/02_reference_stickers/` 的任何参考语料当成品交付。')
  lines.push('- [ ] 出图产物在 `outs/`，提示词与文案在 `texts/`，未混放。')
  lines.push('')
  lines.push('## 总评')
  lines.push('')
  lines.push('| 组 | 结论 | 备注 |')
  lines.push('|---|---|---|')
  for (const group of ['A 文案与排版', 'B 角色一致性', 'C 分镜与情绪', 'D 技术与输出', 'E 交付与合规']) lines.push(`| ${group} | ☐ PASS ☐ FAIL | |`)
  lines.push('')
  lines.push('**判定规则**：A 组 FAIL → 重出或走 `03_*` 兜底；B 组 FAIL → 角色不成立，必须重出；C/D/E 组 FAIL → 回对应文件修正后重跑。')
  lines.push('')
  lines.push('复核人：____________　日期：____________　所用模型与参数：____________________________')
  lines.push('')
  return lines.join('\n')
}

function readmeTemplate({ taskId, title, dirName }) {
  const lines = []
  lines.push(`# ${dirName} · 提示词交付`)
  lines.push('')
  lines.push(`> 任务：${taskId} ${title}`)
  lines.push('> 本目录只写**提示词文本**，不生成、不存放图片；出图产物归 `outs/`。')
  lines.push('')
  lines.push('| 文件 | 作用 |')
  lines.push('|---|---|')
  for (const [key, fileName] of Object.entries(TASK_FILES)) lines.push(`| \`${fileName}\` | ${FILE_ROLE[key]} |`)
  lines.push('')
  lines.push('## 出图前必须确认')
  lines.push('')
  lines.push('- [ ] `00_分镜与文案锁定.md` 的逐字文案已定稿（这是唯一权威文本源）。')
  lines.push('- [ ] 投喂负载已由 `_tools/build_payloads.py` 从本目录逐字抽取到 `_tools/payloads/`。')
  lines.push('- [ ] 出图统一用 `--prompt-file`，禁止 `--prompt-text`、禁止在 pwsh 里内联中文。')
  lines.push('')
  lines.push('## 环境坑（本机实测）')
  lines.push('')
  for (const [index, rule] of ENVIRONMENT_RULES.entries()) lines.push(`${index + 1}. ${rule}`)
  lines.push('')
  return lines.join('\n')
}

/**
 * 规划（或执行）一个新任务的骨架。
 * @param {string} root - 工作区根目录
 * @param {{title?: string, number?: number, write?: boolean, panels?: Array<{marker: string, text: string, note?: string}>}} input
 * @returns {{ok: boolean, wrote: boolean, dryRun?: boolean, plan?: object, error?: string}}
 */
export function scaffoldTask(root, input = {}) {
  const title = String(input.title ?? '').trim() || '未命名题材'
  const number = nextTaskNumber(root, input.number)
  const taskId = taskIdOf(number)
  const dirName = `${taskId}_${slugify(title)}`
  const textsDir = path.join(root, 'texts', dirName)

  const panels = input.panels ?? [
    { marker: '格 1（上格）', text: '第一格台词写在这里，句末用全角句号。' },
    { marker: '格 2（下格）', text: '第二格台词写在这里，句末用全角句号。', note: '（仅「某四字」加粗）' },
  ]

  const files = new Map([
    [TASK_FILES.storyboard, storyboardTemplate({ taskId, title, panels })],
    [TASK_FILES.promptImage2, promptTemplate({ taskId, modelId: 'gpt-image-2' })],
    [TASK_FILES.promptImage25, promptTemplate({ taskId, modelId: 'gpt-image-2.5-sunburst' })],
    [TASK_FILES.textFallback, fallbackTemplate({ taskId })],
    [TASK_FILES.acceptance, acceptanceTemplate({ taskId })],
    ['README.md', readmeTemplate({ taskId, title, dirName })],
  ])

  // 工作流规则：一个任务号只对应一个目录，不允许覆盖已有任务。
  const conflicts = []
  if (existsSync(textsDir)) conflicts.push(textsDir)
  for (const task of listTasks(root).filter(task => task.number === number)) {
    conflicts.push(task.textsDir ?? task.outsDir ?? task.id)
  }

  const plan = {
    taskId,
    title,
    dirName,
    textsDir,
    outDirHint: path.join(root, 'outs', dirName),
    payloadDirHint: path.join(root, '_tools', 'payloads', taskId),
    files: [...files.entries()].map(([fileName, content]) => ({ fileName, chars: content.length })),
    conflicts,
  }

  if (conflicts.length > 0) {
    return {
      ok: false,
      wrote: false,
      plan,
      error: `任务号 ${taskId} 已被占用（${conflicts.join('、')}）。工作流规定不改动已有任务，请换一个任务号或先确认。`,
    }
  }

  if (input.write !== true) return { ok: true, wrote: false, dryRun: true, plan }

  mkdirSync(textsDir, { recursive: true })
  for (const [fileName, content] of files) writeFileSync(path.join(textsDir, fileName), content, 'utf8')
  return { ok: true, wrote: true, dryRun: false, plan }
}

/** 列出 texts/ 下已有的任务目录名。 */
export function existingTaskDirs(root) {
  const textsRoot = path.join(root, 'texts')
  if (!existsSync(textsRoot)) return []
  return readdirSync(textsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
}
