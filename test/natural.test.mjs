/**
 * 自然语言规范化层的测试。
 *
 * 这一层是「减少限制」的核心，所以测两件事：
 *   1. **该认的都认得**：日常说法要能落到合法取值；
 *   2. **不该认的不许猜**：认不出就返回 null，交给后面的严格校验报错 ——
 *      静默猜错一个尺寸或档位的代价是一次付费出图。
 *
 * 另外单独守一个曾出现过的真 bug：「不透明」不能被翻成 transparent。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  parseBackground,
  parseModel,
  parseNatural,
  parsePanels,
  parseQuality,
  parseSize,
  parseStep,
  parseStyle,
  parseTask,
  unresolvedNatural,
} from '../lib/natural.mjs'
import { ALLOWED_SIZES, STYLE_PRESETS } from '../lib/requirements.mjs'
import { runWhaleMeme } from '../lib/tools.mjs'
import { resetTokens } from '../lib/render.mjs'
import { makeFixtureWorkspace } from './helpers.mjs'

describe('自然语言：画风', () => {
  it('中文说法落到预设', () => {
    assert.equal(parseStyle('水彩').style, 'watercolor')
    assert.equal(parseStyle('换成一个水彩风格').style, 'watercolor')
    assert.equal(parseStyle('像素画').style, 'pixel-art')
    assert.equal(parseStyle('赛璐璐').style, 'anime-cel')
    assert.equal(parseStyle('扁平矢量').style, 'flat-vector')
    assert.equal(parseStyle('90年代复古动画').style, 'retro-anime-90s')
    assert.equal(parseStyle('Q版贴纸').style, 'chibi-sticker')
  })

  it('预设 id 与中文标签都直接命中', () => {
    for (const id of Object.keys(STYLE_PRESETS)) {
      assert.equal(parseStyle(id).style, id, `id「${id}」应命中`)
      const label = STYLE_PRESETS[id].label
      assert.equal(parseStyle(label).style, id, `标签「${label}」应命中`)
    }
  })

  it('认不出的画风降级为自定义描述，不报错（减少限制）', () => {
    const result = parseStyle('厚涂油画质感')
    assert.equal(result.style, null)
    assert.equal(result.customStyle, '厚涂油画质感')
    assert.match(result.note, /自定义画风描述/)
  })

  it('每个翻译都带可读的说明', () => {
    assert.match(parseStyle('水彩').note, /水彩/)
    assert.match(parseStyle('水彩').note, /watercolor/)
  })
})

describe('自然语言：尺寸', () => {
  it('方位与比例说法都认得', () => {
    assert.equal(parseSize('方的').size, '1024x1024')
    assert.equal(parseSize('正方形').size, '1024x1024')
    assert.equal(parseSize('1:1').size, '1024x1024')
    assert.equal(parseSize('竖版').size, '1024x1536')
    assert.equal(parseSize('横版').size, '1536x1024')
    assert.equal(parseSize('4:3').size, '1024x768')
  })

  it('字面量与容错符号', () => {
    for (const size of ALLOWED_SIZES) assert.equal(parseSize(size).size, size)
    assert.equal(parseSize('1024×1536').size, '1024x1536')
    assert.equal(parseSize('1024 乘 768').size, '1024x768')
    assert.equal(parseSize('1024*1024').size, '1024x1024')
  })

  it('不允许的尺寸不会被猜成别的档（宁可报错）', () => {
    assert.equal(parseSize('800x800').size, null)
    assert.equal(parseSize('巨幅').size, null)
    assert.equal(parseSize('2560x1440').size, null)
  })

  it('显式的合法值不产生多余说明', () => {
    assert.equal(parseSize('1024x1536').note, null)
  })
})

describe('自然语言：质量档', () => {
  it('程度词落到档位', () => {
    assert.equal(parseQuality('草稿就行').quality, 'low')
    assert.equal(parseQuality('标准').quality, 'medium')
    assert.equal(parseQuality('高清').quality, 'high')
    assert.equal(parseQuality('最高').quality, 'xhigh')
    assert.equal(parseQuality('顶配').quality, 'max')
  })

  it('程度词是推断的，必须给出提醒（否则用户会误以为精确对应）', () => {
    assert.match(parseQuality('高清').note, /推断/)
    assert.equal(parseQuality('high').note, null, '直接给档位不该有推断提醒')
  })

  it('认不出的不猜', () => {
    assert.equal(parseQuality('随便').quality, null)
    assert.equal(parseQuality('中等偏上').quality, null)
  })
})

describe('自然语言：背景（守一个曾出现的真 bug）', () => {
  it('「不透明」必须是 opaque —— 它含「透明」两字，正则写错就会翻反', () => {
    assert.equal(parseBackground('不透明').background, 'opaque')
    assert.equal(parseBackground('不透明背景').background, 'opaque')
    assert.equal(parseBackground('不要透明').background, 'opaque')
  })

  it('真透明仍是 transparent', () => {
    assert.equal(parseBackground('透明').background, 'transparent')
    assert.equal(parseBackground('透明底').background, 'transparent')
    assert.equal(parseBackground('要抠图').background, 'transparent')
    assert.equal(parseBackground('transparent').background, 'transparent')
  })

  it('白底/纯白是 opaque', () => {
    assert.equal(parseBackground('纯白').background, 'opaque')
    assert.equal(parseBackground('白底').background, 'opaque')
    assert.equal(parseBackground('灰白底').background, 'opaque')
  })
})

describe('自然语言：模型与步骤', () => {
  it('模型别名', () => {
    assert.equal(parseModel('2.5').model, 'gpt-image-2.5-sunburst')
    assert.equal(parseModel('sunburst').model, 'gpt-image-2.5-sunburst')
    assert.equal(parseModel('flare').model, 'gpt-image-2.5-flare')
    assert.equal(parseModel('老模型').model, 'gpt-image-2')
    assert.equal(parseModel('gpt-image-2').model, 'gpt-image-2')
  })

  it('步骤说法', () => {
    assert.equal(parseStep('整图').step, 'whole')
    assert.equal(parseStep('母图').step, 'mother')
    assert.equal(parseStep('立绘').step, 'mother')
    assert.equal(parseStep('上格').step, 'upper')
    assert.equal(parseStep('下格').step, 'lower')
    for (const step of ['mother', 'upper', 'lower', 'whole']) assert.equal(parseStep(step).step, step)
  })

  it('认不出的模型/步骤不猜', () => {
    assert.equal(parseModel('最强模型').model, null)
    assert.equal(parseStep('中间那格').step, null)
  })
})

describe('自然语言：格数（不设上限）', () => {
  it('数字与说法都认', () => {
    assert.equal(parsePanels(1).panels, 1)
    assert.equal(parsePanels('单格').panels, 1)
    assert.equal(parsePanels('上下两格').panels, 2)
    assert.equal(parsePanels('三格').panels, 3)
    assert.equal(parsePanels('四格漫画').panels, 4)
  })

  it('格数上限已取消：大数字照收，不设顶', () => {
    assert.equal(parsePanels(6).panels, 6)
    assert.equal(parsePanels(12).panels, 12)
    assert.equal(parsePanels('九格').panels, null, '没有预设说法的数字就不猜')
  })

  it('非正整数不认', () => {
    assert.equal(parsePanels(0).panels, null)
    assert.equal(parsePanels(-3).panels, null)
    assert.equal(parsePanels('很多格').panels, null)
  })
})

describe('自然语言：任务号', () => {
  it('数字、序号、taskNN 都认', () => {
    assert.equal(parseTask('task01').taskId, 'task01')
    assert.equal(parseTask('1').taskId, 'task01')
    assert.equal(parseTask('01').taskId, 'task01')
    assert.equal(parseTask('第一个').taskId, 'task01')
    assert.equal(parseTask('第三个任务').taskId, 'task03')
    assert.equal(parseTask('12').taskId, 'task12')
  })

  it('编号补零到两位', () => {
    assert.equal(parseTask('7').taskId, 'task07')
    assert.equal(parseTask('task7').taskId, 'task07')
  })
})

describe('自然语言：整体翻译与如实报告', () => {
  it('一次把多个参数都翻好，并给出逐条说明', () => {
    const { args, notes } = parseNatural({
      style: '水彩', size: '方的', quality: '最高', background: '透明底', step: '整图', task: '第一个任务',
    })
    assert.equal(args.style, 'watercolor')
    assert.equal(args.size, '1024x1024')
    assert.equal(args.quality, 'xhigh')
    assert.equal(args.background, 'transparent')
    assert.equal(args.step, 'whole')
    assert.equal(args.task, 'task01')
    assert.equal(notes.length, 6, `应逐条说明，实际：${JSON.stringify(notes)}`)
  })

  it('已经是合法取值时不产生说明（不噪声）', () => {
    const { notes } = parseNatural({ size: '1024x1536', quality: 'high', background: 'transparent' })
    assert.deepEqual(notes, [])
  })

  it('认不出的值保持原样，交给严格校验去报错（不静默吞）', () => {
    const { args } = parseNatural({ size: '巨幅', quality: '随便' })
    assert.equal(args.size, '巨幅')
    assert.equal(args.quality, '随便')
    const unresolved = unresolvedNatural({ size: '巨幅', quality: '随便' })
    assert.equal(unresolved.length, 2)
    assert.match(unresolved.join('\n'), /尺寸/)
    assert.match(unresolved.join('\n'), /质量档/)
  })

  it('不相关的字段原样带过', () => {
    const { args } = parseNatural({ action: 'preview', task: 'task01', extra: ['尾鳍不要有白斑'], label: 'v2' })
    assert.equal(args.action, 'preview')
    assert.deepEqual(args.extra, ['尾鳍不要有白斑'])
    assert.equal(args.label, 'v2')
  })
})

describe('自然语言：经工具层端到端生效', () => {
  it('全自然语言的 preview 得到正确的计划', async () => {
    resetTokens()
    const fixture = makeFixtureWorkspace()
    const result = await runWhaleMeme({
      action: 'preview',
      task: fixture.taskId,
      rawPrompt: '【任务】测试用图。',
      style: '水彩',
      size: '方的',
      quality: '最高',
      background: '透明底',
    }, { workspaceRoot: fixture.root })

    assert.equal(result.ok, true, JSON.stringify(result.errors))
    assert.equal(result.planSummary.size, '1024x1024')
    assert.equal(result.planSummary.quality, 'xhigh')
    assert.equal(result.planSummary.background, 'transparent')
    assert.equal(result.planSummary.style, 'watercolor')
  })

  it('序号说法能选中任务（「第一个任务」→ task01）', async () => {
    resetTokens()
    const fixture = makeFixtureWorkspace()
    // 夹具里只有一个任务、号是 task07；「第一个任务」按语法翻成 task01，
    // 对不上就应当**明确报错**（而不是静默改用别的任务）
    const result = await runWhaleMeme({
      action: 'preview', task: '第一个任务', rawPrompt: '【任务】测试用图。',
    }, { workspaceRoot: fixture.root })
    assert.equal(result.ok, false)
    assert.match(result.error, /task01/)
    assert.match(result.error, /task07/, '报错要列出实际可用的任务号')
  })

  it('回复里回显「我把你的话理解成什么」', async () => {
    resetTokens()
    const fixture = makeFixtureWorkspace()
    const result = await runWhaleMeme({
      action: 'preview', task: fixture.taskId, rawPrompt: '【任务】测试用图。', style: '水彩', size: '方的',
    }, { workspaceRoot: fixture.root })
    assert.match(result.reply, /我把你的话理解成/)
    assert.match(result.reply, /水彩/)
    assert.match(result.reply, /1024x1024/)
    assert.ok(Array.isArray(result.naturalNotes) && result.naturalNotes.length >= 2)
  })

  it('自定义画风经工具层仍生效，并显示为「自定义描述」', async () => {
    resetTokens()
    const fixture = makeFixtureWorkspace()
    const result = await runWhaleMeme({
      action: 'preview', task: fixture.taskId, rawPrompt: '【任务】测试用图。', style: '厚涂油画质感',
    }, { workspaceRoot: fixture.root })
    assert.equal(result.ok, true, '自定义画风不该被拒')
    assert.equal(result.planSummary.customStyle, '厚涂油画质感')
    assert.equal(result.planSummary.style, null)
    assert.match(result.reply, /自定义描述/)
    assert.ok(result.planSummary.prompt.text.includes('厚涂油画质感'), '自定义画风要真的拼进提示词')
  })

  it('认不出的尺寸仍然报错，不会被自然语言层放过', async () => {
    resetTokens()
    const fixture = makeFixtureWorkspace()
    const result = await runWhaleMeme({
      action: 'preview', task: fixture.taskId, rawPrompt: '【任务】测试用图。', size: '巨幅',
    }, { workspaceRoot: fixture.root })
    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /巨幅/)
  })

  it('四格经工具层放行，并写进版式说明', async () => {
    resetTokens()
    const fixture = makeFixtureWorkspace()
    const result = await runWhaleMeme({
      action: 'preview', task: fixture.taskId, rawPrompt: '【任务】测试用图。', panels: '四格漫画',
    }, { workspaceRoot: fixture.root })
    assert.equal(result.ok, true, JSON.stringify(result.errors))
    assert.equal(result.planSummary.panels, 4)
    assert.match(result.planSummary.prompt.text, /画面分 4 格/)
  })
})
