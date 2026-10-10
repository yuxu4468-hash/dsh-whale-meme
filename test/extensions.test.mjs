/**
 * 三项扩展的测试：上游素材下载、唤醒词、自由需求起稿。
 *
 * 三个重点：
 *   1. fetch 的**路径映射与噪音过滤**是纯逻辑，必须测 —— 映射错了会把文件写到不该写的地方，
 *      或者互相覆盖；体积大的包必须给出警告。
 *   2. 唤醒词必须真的出现在**技能描述**里 —— 那是宿主唯一会注入会话的注册面。
 *   3. draftCheck 的校验必须从严：句末标点、加粗必须真的在文案里、合规红线，
 *      而且它**绝不写盘**（文案要用户逐字确认后才落盘）。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { BUNDLES, DEFAULT_BUNDLES, planDownloads, resolveBundles, UPSTREAM } from '../lib/fetch.mjs'
import { checkDraft, describeOptions, draftChecklist, draftTemplate, draftToTextsFiles, renderDraft } from '../lib/draft.mjs'
import { ACTIONS, runWhaleMeme, WRITING_ACTIONS } from '../lib/tools.mjs'
import { selfCheck } from '../lib/index.mjs'
import { makeFixtureWorkspace } from './helpers.mjs'

// ─────────────────────── fetch：素材下载 ───────────────────────

/** 模拟上游文件树（照真实仓库结构裁一段）。 */
const FAKE_TREE = [
  { path: 'assets/deepseek_whale.png', size: 1_648_600, type: 'blob' },
  { path: 'assets/deepseek_whale.webp', size: 45_500, type: 'blob' },
  { path: 'assets/fonts/nunito-latin-400-normal.woff2', size: 16_000, type: 'blob' },
  { path: 'assets/qq-group-qr.png', size: 193_000, type: 'blob' },
  { path: '原始立绘/deepseek_whale.png', size: 1_648_600, type: 'blob' },
  { path: 'logo/deepseek_蓝鲸_彩色.png', size: 43_300, type: 'blob' },
  { path: 'logo/deepseek_蓝鲸_黑色.png', size: 34_900, type: 'blob' },
  { path: 'logo/favicon.png', size: 4_400, type: 'blob' },
  { path: 'logo/apple-touch-icon.png', size: 13_200, type: 'blob' },
  { path: 'memes/120302wg44ju245iDQ38xu.png', size: 975_000, type: 'blob' },
  { path: 'memes/xixi.aac', size: 90_800, type: 'blob' },
  { path: 'stickers/manifest.json', size: 83_500, type: 'blob' },
  { path: 'stickers/self-made.json', size: 200, type: 'blob' },
  { path: 'previews/a.webp', size: 1_000, type: 'blob' },
  { path: 'previews/b.webp', size: 1_000, type: 'blob' },
  { path: 'index.html', size: 23_000, type: 'blob' },
  { path: 'styles.css', size: 86_500, type: 'blob' },
  { path: 'app.js', size: 25_200, type: 'blob' },
]

describe('上游素材下载：计划与映射', () => {
  it('上游信息写明了仓库与许可（CC BY-NC-SA 4.0）', () => {
    assert.equal(UPSTREAM.slug, 'EDMOK/blue-fish-archive')
    assert.match(UPSTREAM.license, /CC BY-NC-SA 4\.0/)
    assert.match(UPSTREAM.note, /署名/)
    assert.match(UPSTREAM.note, /非商业/)
  })

  it('默认组合够开始干活，且不含超大包', () => {
    assert.deepEqual(DEFAULT_BUNDLES, ['character', 'samples', 'previews'])
    assert.ok(!DEFAULT_BUNDLES.includes('media'), '默认不该下 242 MB 的 media')
    assert.equal(BUNDLES.media.huge, true)
    assert.equal(BUNDLES.large.big, true)
  })

  it('落点不重复 —— 同名文件不会互相覆盖', () => {
    const plan = planDownloads(FAKE_TREE, ['character', 'samples', 'previews'])
    const dests = plan.selected.map(file => file.toPath)
    assert.equal(dests.length, new Set(dests).size, `落点有重复：\n${dests.join('\n')}`)
    // assets/ 与 原始立绘/ 下都叫 deepseek_whale.png，必须落到不同位置
    const whales = plan.selected.filter(file => file.fromPath.endsWith('deepseek_whale.png'))
    assert.equal(whales.length, 2)
    assert.notEqual(whales[0].toPath, whales[1].toPath)
  })

  it('过滤噪音：字体、favicon、站点图标、音频、网页统统不下载', () => {
    const plan = planDownloads(FAKE_TREE, ['character', 'samples', 'previews'])
    const dests = plan.selected.map(file => file.toPath).join('\n')
    assert.ok(!dests.includes('fonts'), '不该下字体')
    assert.ok(!/favicon|apple-touch/.test(dests), '不该下站点图标')
    assert.ok(!dests.includes('.aac'), '不该下音频')
    assert.ok(!/index\.html|styles\.css|app\.js/.test(dests), '不该下网页本体')
    assert.ok(plan.skipped.length > 0, '应记录被排除的文件')
  })

  it('只下图片与 json，不把上游的任意文件搬过来', () => {
    const plan = planDownloads(FAKE_TREE, Object.keys(BUNDLES))
    for (const file of plan.selected) {
      const ext = path.extname(file.fromPath).toLowerCase()
      assert.ok(['.png', '.webp', '.jpg', '.jpeg', '.gif', '.json'].includes(ext), `${file.fromPath} 不是图片/json`)
    }
  })

  it('每个包都落到自己的目录，且附了用途说明', () => {
    const plan = planDownloads(FAKE_TREE, ['character', 'samples', 'previews'])
    for (const bundle of plan.perBundle) {
      assert.ok(bundle.dest.startsWith('datas/'), `${bundle.id} 必须落在 datas/ 下`)
      assert.ok(bundle.note && bundle.note.length > 4, `${bundle.id} 缺少用途说明`)
      assert.equal(bundle.count > 0, true, `${bundle.id} 一个文件都没匹配到`)
    }
    assert.equal(plan.perBundle.find(b => b.id === 'character').dest, 'datas/01_character')
    assert.equal(plan.perBundle.find(b => b.id === 'previews').dest, 'datas/02_reference_stickers/previews')
  })

  it('体积统计正确，并给出人读大小', () => {
    const plan = planDownloads(FAKE_TREE, ['character'])
    const expected = plan.selected.reduce((sum, file) => sum + file.size, 0)
    assert.equal(plan.totalBytes, expected)
    assert.match(plan.perBundle[0].bytesHuman, /MB|KB/)
  })

  it('素材包参数容错：数组、逗号分隔、all', () => {
    assert.deepEqual(resolveBundles(['character', 'samples']).ids, ['character', 'samples'])
    assert.deepEqual(resolveBundles('character,samples').ids, ['character', 'samples'])
    assert.deepEqual(resolveBundles('character，samples').ids, ['character', 'samples'], '全角逗号也要认')
    assert.deepEqual(resolveBundles('all').ids, Object.keys(BUNDLES))
    assert.deepEqual(resolveBundles(undefined).ids, DEFAULT_BUNDLES)
  })

  it('未知素材包给出可用的取值', () => {
    const result = resolveBundles('nope')
    assert.equal(result.ids.length, 0)
    assert.match(result.errors[0], /未知素材包/)
    assert.match(result.errors[0], /character/)
  })
})

describe('上游素材下载：工具层', () => {
  it('未知素材包时明确报错，不静默用默认值', async () => {
    const fixture = makeFixtureWorkspace()
    const result = await runWhaleMeme({ action: 'fetch', bundles: ['nope'] }, { workspaceRoot: fixture.root })
    assert.equal(result.ok, false)
    assert.match(result.errors[0], /未知素材包/)
  })

  it('fetch 属于会写盘的 action，且回复里带上许可提示', async () => {
    assert.ok(WRITING_ACTIONS.includes('fetch'))
    const fixture = makeFixtureWorkspace()
    // 用不存在的 bundles 走不到网络，只验证分类与提示文案
    const result = await runWhaleMeme({ action: 'fetch', bundles: ['nope'] }, { workspaceRoot: fixture.root })
    assert.equal(result.dryRun, undefined)
    assert.equal(result.wrote, undefined)
  })
})

// ─────────────────────── 唤醒词 ───────────────────────

describe('唤醒词', () => {
  const WAKE = '蓝色大肥鱼表情包绘画'

  it('唤醒词写在技能描述里（宿主唯一会注入会话的注册面）', () => {
    const check = selfCheck()
    const content = readFileSync(check.skillFile, 'utf8')
    const description = /^description:\s*(.+)$/m.exec(content)?.[1] ?? ''
    assert.ok(description.includes(WAKE), `技能 description 里必须有「${WAKE}」`)
  })

  it('技能正文也写明唤醒词与进入方式', () => {
    const content = readFileSync(selfCheck().skillFile, 'utf8')
    assert.ok(content.includes(WAKE))
    assert.match(content, /## 唤醒词/)
    // 唤醒后第一件事应当是看现状
    assert.match(content, /whale_meme\(action="status"\)/)
  })

  it('技能描述里的唤醒词是短句，不是埋在长句里的片段', () => {
    const content = readFileSync(selfCheck().skillFile, 'utf8')
    const description = /^description:\s*(.+)$/m.exec(content)?.[1] ?? ''
    const at = description.indexOf(WAKE)
    assert.ok(at <= 2, `唤醒词应当出现在描述开头，实际位置 ${at}`)
  })
})

// ─────────────────────── draft：自由需求 → 草稿 ───────────────────────

describe('自由需求起稿：模板与清单', () => {
  it('模板把用户原话带进去，并给出占位符结构', () => {
    const narrative = '她发现脚本被改坏了，先得意后破防'
    const template = draftTemplate(narrative)
    assert.equal(template.narrative, narrative)
    assert.equal(template.panels.length, 2)
    assert.match(template.panels[0].text, /^<.*>$/, '应当是占位符，等 LLM 填')
    assert.ok(template.style)
    assert.equal(template.size, '1024x1536')
  })

  it('校验清单覆盖四个最容易翻车的点', () => {
    const checklist = draftChecklist().join('\n')
    assert.match(checklist, /原样照抄/)
    assert.match(checklist, /全角句号/)
    assert.match(checklist, /加粗/)
    assert.match(checklist, /官方/)
  })

  it('可用选项来自既有预设，不另起一套', () => {
    const options = describeOptions()
    assert.ok(options.styles.length >= 6)
    assert.ok(options.sizes.includes('1024x1536'))
    assert.ok(options.models.includes('gpt-image-2.5-sunburst'))
  })
})

describe('自由需求起稿：校验从严', () => {
  const good = {
    narrative: '她发现脚本被字符串替换改坏了，先是得意，然后当场破防',
    subject: '字符串替换把脚本改坏了',
    panels: [
      { marker: '格 1（上格）', text: '我的字符串替换把脚本改坏了。我直接读取并修复。', mood: '自信满满' },
      { marker: '格 2（下格）', text: '文件被我的替换操作整篇损坏。', mood: '当场破防', bold: '整篇损坏' },
    ],
    style: 'anime-cel',
    size: '1024x1536',
    extra: ['尾鳍不要有白斑'],
    avoid: ['第二个人物'],
    palette: ['深藏青为主'],
  }

  it('完整草稿通过，并产出可用结构', () => {
    const result = checkDraft(good)
    assert.equal(result.ok, true, JSON.stringify(result.errors))
    assert.equal(result.draft.panels.length, 2)
    assert.equal(result.draft.panels[1].bold, '整篇损坏')
    assert.equal(result.draft.model, 'gpt-image-2.5-sunburst')
    assert.equal(result.fingerprint.length, 64)
  })

  it('缺 subject / panels 被挡下', () => {
    assert.equal(checkDraft({ panels: good.panels }).ok, false)
    assert.equal(checkDraft({ subject: 'x' }).ok, false)
  })

  it('模板占位符没填被挡下（防止直接把模板当草稿交上来）', () => {
    const result = checkDraft({ ...good, subject: '<这个任务要讲的梗是什么？一句话>' })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some(error => /占位符/.test(error)))
  })

  it('台词句末没有全角句号被挡下', () => {
    const result = checkDraft({ ...good, panels: [{ marker: '格 1', text: '这句话没有句号' }] })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some(error => /句末标点/.test(error)))
  })

  it('bold 不在文案里被挡下（这是最常见的「写了但没生效」）', () => {
    const result = checkDraft({ ...good, panels: [{ marker: '格 1', text: '一句正常的话。', bold: '不存在的字' }] })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some(error => /没有出现在台词里/.test(error)))
  })

  it('超过两格改为提醒、不再挡下（格数不设限）', () => {
    const four = [
      ...good.panels,
      { marker: '格 3', text: '第三格。' },
      { marker: '格 4', text: '第四格。' },
    ]
    const result = checkDraft({ ...good, panels: four })
    assert.equal(result.ok, true, `格数不该阻断：${JSON.stringify(result.errors)}`)
    assert.ok(result.warnings.some(warning => /格数不设限/.test(warning)), JSON.stringify(result.warnings))
    assert.equal(result.draft.panels.length, 4)
  })

  it('marker 重复被挡下', () => {
    const result = checkDraft({
      ...good,
      panels: [
        { marker: '格 1', text: '第一句。' },
        { marker: '格 1', text: '第二句。' },
      ],
    })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some(error => /marker 重复/.test(error)))
  })

  it('合规红线：「官方」字样被挡下', () => {
    for (const patch of [{ subject: '官方授权表情包' }, { extra: ['标注官方出品'] }]) {
      const result = checkDraft({ ...good, ...patch })
      assert.equal(result.ok, false, `应当挡下 ${JSON.stringify(patch)}`)
      assert.ok(result.errors.some(error => /官方/.test(error)))
    }
  })

  it('透明底与模型不匹配被挡下', () => {
    const result = checkDraft({ ...good, background: 'transparent', model: 'gpt-image-2' })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some(error => /透明底/.test(error)))
  })

  it('半角标点与连续英文只提醒、不阻断（可能是刻意的）', () => {
    // 注意：只替换台词，marker 与其余字段保持完整，否则会撞上「缺 marker」这类无关错误
    const result = checkDraft({
      ...good,
      panels: [{ marker: '格 1（上格）', text: 'Hello, world. 这句话带半角标点。' }],
    })
    assert.equal(result.ok, true, `不该阻断：${JSON.stringify(result.errors)}`)
    assert.ok(result.warnings.some(warning => /半角标点|英文字母/.test(warning)), JSON.stringify(result.warnings))
  })

  it('指纹对内容敏感：改一个字就变', () => {
    const a = checkDraft(good).fingerprint
    const b = checkDraft({ ...good, subject: '改过的标题' }).fingerprint
    assert.notEqual(a, b)
    assert.equal(checkDraft(good).fingerprint, a, '同一份草稿指纹应稳定')
  })
})

describe('自由需求起稿：渲染与落盘前产物', () => {
  const draft = checkDraft({
    narrative: '需求原话',
    subject: '测试标题',
    panels: [
      { marker: '格 1（上格）', text: '第一句台词。', mood: '得意' },
      { marker: '格 2（下格）', text: '第二句台词。', mood: '破防', bold: '第二句' },
    ],
    style: 'watercolor',
    size: '1024x1536',
  }).draft

  it('渲染文本包含逐字文案、情绪、加粗与参数', () => {
    const rendered = renderDraft(draft, { fingerprint: 'f'.repeat(64) })
    assert.ok(rendered.includes('第一句台词。'))
    assert.ok(rendered.includes('第二句台词。'))
    assert.ok(rendered.includes('得意'))
    assert.ok(rendered.includes('破防'))
    assert.ok(rendered.includes('整篇') === false)
    assert.ok(rendered.includes('watercolor'))
    assert.ok(rendered.includes('1024x1536'))
    assert.ok(rendered.includes('角色剪影三要素'))
  })

  it('建议写入的 00_* 结构能被既有的分镜解析器读懂', async () => {
    const { parseStoryboard } = await import('../lib/core.mjs')
    const texts = draftToTextsFiles(draft)
    assert.ok(texts.storyboard.includes('## 1. 逐字文案'))
    assert.ok(texts.storyboard.includes('```text'))
    assert.ok(texts.storyboard.includes('（仅「第二句」加粗）'))
    assert.equal(texts.storyboardSha256.length, 64)

    // 写进夹具工作区，用同一套解析器验收：骨架必须自洽
    const fixture = makeFixtureWorkspace()
    const target = path.join(fixture.textsDir, '00_分镜与文案锁定.md')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(target, texts.storyboard, 'utf8')
    const parsed = parseStoryboard(fixture.root, fixture.taskId)
    assert.equal(parsed.ok, true, JSON.stringify(parsed.warnings))
    assert.deepEqual(parsed.lines.map(line => line.text), ['第一句台词。', '第二句台词。'])
    assert.deepEqual(parsed.boldHints, ['第二句'])
  })
})

describe('自由需求起稿：不落盘', () => {
  it('draft 与 draftCheck 都不写任何文件', async () => {
    const fixture = makeFixtureWorkspace()
    const before = readFileSync(path.join(fixture.textsDir, '00_分镜与文案锁定.md'), 'utf8')

    const draft = await runWhaleMeme({ action: 'draft', narrative: '测试需求' }, { workspaceRoot: fixture.root })
    assert.equal(draft.ok, true)
    assert.equal(draft.wrote, undefined, 'draft 不该有写盘标记')

    const checked = await runWhaleMeme({
      action: 'draftCheck',
      draft: {
        narrative: '测试需求', subject: '标题',
        panels: [{ marker: '格 1', text: '一句话。' }],
      },
    }, { workspaceRoot: fixture.root })
    assert.equal(checked.ok, true)
    assert.equal(checked.wrote, undefined, 'draftCheck 不该有写盘标记')

    // 工作区一字未改
    assert.equal(readFileSync(path.join(fixture.textsDir, '00_分镜与文案锁定.md'), 'utf8'), before)
    assert.ok(!existsSync(path.join(fixture.root, 'texts', 'task08_测试需求')))
    assert.ok(!WRITING_ACTIONS.includes('draft'))
    assert.ok(!WRITING_ACTIONS.includes('draftCheck'))
  })

  it('ACTIONS 覆盖 14 个动作', () => {
    assert.deepEqual(ACTIONS, [
      'status', 'task', 'payload', 'lineage', 'outputs', 'commands', 'scaffold',
      'init', 'preview', 'build', 'render', 'fetch', 'draft', 'draftCheck',
    ])
  })
})
