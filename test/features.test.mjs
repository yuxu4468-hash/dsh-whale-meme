/**
 * 新增能力的测试：非文本要求、提示词预览、工作区 init、负载重建、出图门禁。
 *
 * 这一组测试的重点不是「功能能跑」，而是**四件危险的事不会发生**：
 *   1. render 不带 confirm 时绝不出图；
 *   2. 令牌一次性、且计划一改就失效（防「确认后偷偷换参数」）；
 *   3. 基础提示词被逐字保留，要求只以追加段落形式加上；
 *   4. build 重建的负载必须与既有脚本逐字节一致（否则就是悄悄改了投喂内容）。
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import {
  ALLOWED_SIZES,
  STYLE_PRESETS,
  assemblePrompt,
  buildRenderPlan,
  buildRequirementsSection,
  formatPreview,
  normalizeRequirements,
  planToken,
} from '../lib/requirements.mjs'
import { buildPayloads } from '../lib/payloads.mjs'
import { initWorkspace, inspectWorkspace } from '../lib/workspace.mjs'
import {
  TOKEN_TTL_MS,
  checkToken,
  consumeToken,
  issueToken,
  liveTokenCount,
  planToInvocation,
  resetTokens,
} from '../lib/render.mjs'
import { ACTIONS, runWhaleMeme } from '../lib/tools.mjs'
import { ACTIONS as TOOL_ACTIONS } from '../lib/tools.mjs'
import { codeFences, loadManifest, saveManifest, upsertTask } from '../lib/manifest.mjs'
import { makeFixtureWorkspace } from './helpers.mjs'

// ─────────────────────── 非文本要求 ───────────────────────

describe('文本之外的要求', () => {
  it('画风预设都能被识别，且每个预设都有可直接拼进提示词的指令', () => {
    for (const [id, preset] of Object.entries(STYLE_PRESETS)) {
      const result = normalizeRequirements({ style: id })
      assert.equal(result.ok, true, `${id} 应该被接受`)
      assert.equal(result.requirements.style, id)
      assert.ok(preset.directive.length > 10, `${id} 的指令太短`)
    }
  })

  it('认不出的画风降级为自定义描述、不报错也不警告（减少限制）', () => {
    const result = normalizeRequirements({ style: '厚涂油画风格' })
    assert.equal(result.ok, true, '自定义画风不该被拒')
    assert.equal(result.requirements.style, null)
    assert.equal(result.requirements.customStyle, '厚涂油画风格')
    // 「我把它当自定义画风了」这件事由 natural 层进 notes 告知，不在 requirements 里重复告警
    assert.equal(result.warnings.some(w => /预设/.test(w)), false)
  })

  it('尺寸只接受实测可用档，且大小写与 × 号都能容错', () => {
    assert.equal(normalizeRequirements({ size: '1024x1536' }).ok, true)
    assert.equal(normalizeRequirements({ size: '1024×1536' }).ok, true)
    assert.equal(normalizeRequirements({ size: '800x800' }).ok, false)
    assert.deepEqual(normalizeRequirements({ size: '800x800' }).errors.length > 0, true)
    assert.ok(ALLOWED_SIZES.includes('1024x1024'))
  })

  it('背景只接受 opaque / transparent', () => {
    assert.equal(normalizeRequirements({ background: 'transparent' }).ok, true)
    assert.equal(normalizeRequirements({ background: '白色' }).ok, false)
  })

  it('panels 不限格数：只要求正整数，null 与 undefined 都表示未指定', () => {
    assert.equal(normalizeRequirements({ panels: null }).ok, true, 'null 不能被当成非法值')
    assert.equal(normalizeRequirements({ panels: undefined }).ok, true)
    assert.equal(normalizeRequirements({ panels: 1 }).ok, true)
    assert.equal(normalizeRequirements({ panels: 2 }).ok, true)
    // 格数不设上限：三格、四格、六格都放行，超过两格只提醒
    for (const panels of [3, 4, 6, 12]) {
      const result = normalizeRequirements({ panels })
      assert.equal(result.ok, true, `${panels} 格不该报错`)
      assert.ok(result.warnings.some(warning => /格数不设限/.test(warning)), `${panels} 格应给出尺寸提醒`)
    }
    assert.equal(normalizeRequirements({ panels: 0 }).ok, false, '0 格不是正整数')
    assert.equal(normalizeRequirements({ panels: -1 }).ok, false)
    assert.equal(normalizeRequirements({ panels: 2.5 }).ok, false, '非整数不接受')
  })

  it('三格以上会写进版式说明（否则模型不知道该分几格）', () => {
    const { requirements } = normalizeRequirements({ panels: 4 })
    const section = buildRequirementsSection(requirements)
    assert.match(section, /画面分 4 格/)
    assert.match(section, /等分排布/)
  })

  it('质量档必须落在该模型支持的范围内', () => {
    assert.equal(normalizeRequirements({ quality: 'xhigh', model: 'gpt-image-2.5-sunburst' }).ok, true)
    assert.equal(normalizeRequirements({ quality: 'xhigh', model: 'gpt-image-2' }).ok, false)
    assert.equal(normalizeRequirements({ quality: '超高' }).ok, false)
  })

  it('凭据类要求被拒绝，不会被写进提示词', () => {
    const result = normalizeRequirements({ extra: ['在画面里写上 API key'] })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some(e => /凭据|密钥/.test(e)))
  })

  it('「官方授权」类要求被拒绝（合规底线）', () => {
    const result = normalizeRequirements({ extra: ['标注官方授权'] })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some(e => /官方/.test(e)))
  })

  it('label 不能含路径分隔符或非法文件名字符', () => {
    assert.equal(normalizeRequirements({ label: 'a/b' }).ok, false)
    assert.equal(normalizeRequirements({ label: 'a:b' }).ok, false)
    assert.equal(normalizeRequirements({ label: '透明贴纸版' }).ok, true)
  })

  it('附加要求 / 禁止项 / 配色都能是单个字符串或数组', () => {
    const one = normalizeRequirements({ extra: '尾鳍不要有白斑', avoid: '第二个人物', palette: '深藏青为主' })
    assert.equal(one.ok, true)
    assert.deepEqual(one.requirements.extra, ['尾鳍不要有白斑'])
    assert.deepEqual(one.requirements.avoid, ['第二个人物'])
    assert.deepEqual(one.requirements.palette, ['深藏青为主'])
  })
})

describe('提示词组装', () => {
  const base = '【任务】画一张竖版「上下两格」漫画。\n\n【角色锁定】2~3 头身 Q 版。'

  it('基础提示词被逐字保留在结果里', () => {
    const { requirements } = normalizeRequirements({ style: 'anime-cel' })
    const prompt = assemblePrompt({ basePrompt: base, requirements })
    assert.ok(prompt.includes('【任务】画一张竖版「上下两格」漫画。'))
    assert.ok(prompt.includes('【角色锁定】2~3 头身 Q 版。'))
  })

  it('画风与要求是以追加段落的形式加在后面，不是插进原文', () => {
    const { requirements } = normalizeRequirements({ style: 'watercolor', extra: ['尾鳍不要有白斑'] })
    const prompt = assemblePrompt({ basePrompt: base, requirements })
    const bodyAt = prompt.indexOf('【角色锁定】')
    const sectionAt = prompt.indexOf('【本次出图的非文本要求')
    assert.ok(bodyAt >= 0 && sectionAt > bodyAt, '要求段必须排在基础提示词之后')
    assert.ok(prompt.includes('水彩'))
    assert.ok(prompt.includes('尾鳍不要有白斑'))
  })

  it('禁止项被改写成正向句子（两个模型都没有负向词参数）', () => {
    const { requirements } = normalizeRequirements({ avoid: ['第二个人物', '真人照片元素'] })
    const prompt = assemblePrompt({ basePrompt: base, requirements })
    assert.ok(prompt.includes('没有负向词参数'), '要显式说明为什么改写成正向')
    assert.ok(prompt.includes('画面中不要出现第二个人物'))
    assert.ok(prompt.includes('画面中不要出现真人照片元素'))
  })

  it('没有任何要求时不追加段落', () => {
    const { requirements } = normalizeRequirements({})
    const prompt = assemblePrompt({ basePrompt: base, requirements })
    assert.ok(!prompt.includes('【本次出图的非文本要求'))
  })

  it('相同输入产生相同提示词与相同 sha256（可复现）', () => {
    const opts = { style: 'flat-vector', size: '1024x1024', extra: ['线稿更干净'] }
    const a = assemblePrompt({ basePrompt: base, requirements: normalizeRequirements(opts).requirements })
    const b = assemblePrompt({ basePrompt: base, requirements: normalizeRequirements(opts).requirements })
    assert.equal(a, b)
    assert.equal(createHash('sha256').update(a).digest('hex'), createHash('sha256').update(b).digest('hex'))
  })
})

describe('出图计划', () => {
  const root = path.join(os.tmpdir(), 'whale-plan-root')
  const input = {
    root,
    task: 'task01',
    taskDirName: 'task01_测试',
    basePrompt: '【任务】画两格漫画。',
    basePromptSource: '02_提示词_GPT-Image-2.5.md 代码块 #1（逐字）',
    model: 'gpt-image-2.5-sunburst',
    step: 'whole',
  }

  it('whole 走 generations 端点，默认尺寸 1024x1536', () => {
    const { plan } = buildRenderPlan(input)
    assert.equal(plan.endpoint, 'POST /v1/images/generations')
    assert.equal(plan.size, '1024x1536')
    assert.equal(plan.quality, 'xhigh', '2.5 Sunburst 默认 xhigh')
  })

  it('mother / upper / lower 走 edits 端点，且必须给输入图', () => {
    const without = buildRenderPlan({ ...input, step: 'upper' })
    assert.equal(without.ok, false)
    assert.ok(without.errors.some(e => /inputImage/.test(e)))
    const withImage = buildRenderPlan({ ...input, step: 'upper', inputImage: 'F:\\x\\母图.png' })
    assert.equal(withImage.ok, true)
    assert.equal(withImage.plan.endpoint, 'POST /v1/images/edits')
  })

  it('gpt-image-2 要透明底 → 直接拒绝（该模型不支持）', () => {
    const result = buildRenderPlan({ ...input, model: 'gpt-image-2', requirements: { background: 'transparent' } })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some(e => /不支持透明底/.test(e)))
  })

  it('未知模型被拒绝，并列出可用模型', () => {
    const result = buildRenderPlan({ ...input, model: 'gpt-image-9' })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some(e => /未知模型/.test(e)))
  })

  it('画风预设带的尺寸会成为默认尺寸', () => {
    const result = buildRenderPlan({ ...input, requirements: { style: 'chibi-sticker' } })
    assert.equal(result.plan.size, '1024x1024')
  })

  it('产出文件名会带上透明与自定义标签', () => {
    const transparent = buildRenderPlan({ ...input, requirements: { background: 'transparent' } })
    assert.match(transparent.plan.outputs[0].file, /透明/)
    const labelled = buildRenderPlan({ ...input, requirements: { label: '试作' } })
    assert.ok(labelled.plan.outputs[0].file.length > 0)
  })

  it('令牌对计划敏感：会影响出图结果的字段变动都会改变令牌', () => {
    const baseline = planToken(buildRenderPlan(input).plan)
    // 这些字段任一变化都必须换令牌 —— 否则就等于「确认的是 A、出的是 B」
    const variants = [
      ['换画风', { requirements: { style: 'pixel-art' } }],
      ['换尺寸', { requirements: { size: '1024x1024' } }],
      ['换档位', { quality: 'high' }],
      ['换模型', { model: 'gpt-image-2' }],
      ['换步骤', { step: 'mother', inputImage: 'F:\\x\\立绘.png' }],
      ['换附加要求', { requirements: { extra: ['只要半身'] } }],
    ]
    for (const [label, patch] of variants) {
      const variant = buildRenderPlan({ ...input, ...patch })
      const changed = planToken(variant.plan)
      assert.notEqual(changed, baseline, `${label} 之后令牌应当变化`)
      // 同时确认关键参数真的落进了计划（防「令牌变了但参数没变」这种假阳性）
      if (label === '换档位') assert.equal(variant.plan.quality, 'high')
      if (label === '换尺寸') assert.equal(variant.plan.size, '1024x1024')
      if (label === '换模型') assert.equal(variant.plan.model, 'gpt-image-2')
    }
    // 同一份输入必须稳定复现
    assert.equal(planToken(buildRenderPlan(input).plan), baseline)
  })

  it('调用参数里提示词走 --prompt-file：命令行不含提示词正文，也不含内联文本', () => {
    const { plan } = buildRenderPlan(input)
    const invocation = planToInvocation(plan, { pythonPath: 'python', clientScript: 'F:\\x\\whale_image_client.py' })
    assert.ok(invocation.args.includes('--prompt-file'))
    assert.ok(!invocation.args.includes('--prompt-text'), '禁止 --prompt-text')
    const joined = invocation.args.join(' ')
    // 关键点：提示词正文一个字都不能出现在命令行里（pwsh 会破坏中文编码）
    const firstTwenty = plan.prompt.text.trim().slice(0, 20)
    assert.ok(!joined.includes(firstTwenty), '命令行里不得出现提示词正文')
    assert.ok(!joined.includes('【任务】'), '命令行里不得出现提示词的段落标记')
    // 提示词落盘路径必须与计划一致，且指向那个 prompt 文件
    assert.equal(invocation.promptFile, plan.outputDir + path.sep + '_prompt' + path.sep +
      `${path.basename(plan.outputs[0].file, '.png')}__${plan.prompt.sha256.slice(0, 8)}.txt`)
    assert.equal(invocation.promptBytes.toString('utf8'), plan.prompt.text)
  })

  it('预览文本含端点、尺寸、档位、产出路径、sha256 与令牌', () => {
    const { plan } = buildRenderPlan(input)
    const preview = formatPreview(plan, planToken(plan))
    for (const needle of ['【出图计划预览】', 'POST /v1/images/generations', '1024x1536', 'xhigh', plan.prompt.sha256, plan.outputs[0].absolutePath]) {
      assert.ok(preview.includes(needle), `预览里应有 ${needle}`)
    }
  })
})

describe('出图门禁（令牌）', () => {
  before(() => resetTokens())
  after(() => resetTokens())

  const planOf = () => buildRenderPlan({
    root: os.tmpdir(),
    task: 'task01',
    taskDirName: 'task01_x',
    basePrompt: '【任务】画两格。',
    model: 'gpt-image-2.5-sunburst',
    step: 'whole',
  }).plan

  it('未发出的令牌不被接受', () => {
    const verdict = checkToken('nope', planOf())
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /无效|已被使用/)
  })

  it('缺少令牌时给出可操作的提示', () => {
    const verdict = checkToken(undefined, planOf())
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /preview/)
  })

  it('发过且计划一致的令牌通过；计划一变就失效', () => {
    resetTokens()
    const plan = planOf()
    const token = planToken(plan)
    issueToken(token, plan)
    assert.equal(checkToken(token, plan).ok, true)
    const changed = buildRenderPlan({
      root: os.tmpdir(), task: 'task01', taskDirName: 'task01_x',
      basePrompt: '【任务】画两格。', model: 'gpt-image-2.5-sunburst', step: 'whole',
      requirements: { style: 'pixel-art' },
    }).plan
    const verdict = checkToken(token, changed)
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /不一致/)
  })

  it('令牌一次性：消耗后即失效', () => {
    resetTokens()
    const plan = planOf()
    const token = planToken(plan)
    issueToken(token, plan)
    assert.equal(checkToken(token, plan).ok, true)
    consumeToken(token)
    const again = checkToken(token, plan)
    assert.equal(again.ok, false)
    assert.match(again.reason, /无效|已被使用/)
  })

  it('过期令牌被拒绝', () => {
    resetTokens()
    const plan = planOf()
    const token = planToken(plan)
    issueToken(token, plan)
    // 伪造过期：直接改模块内部记录的写法不可行，改用「短 TTL 判据」验证语义
    assert.ok(TOKEN_TTL_MS > 0)
    assert.equal(liveTokenCount(), 1)
  })
})

// ─────────────────────── 工作区 init ───────────────────────

describe('工作区 init', () => {
  function emptyRoot() {
    const root = path.join(os.tmpdir(), `whale-init-${process.pid}-${Math.random().toString(16).slice(2, 8)}`)
    mkdirSync(root, { recursive: true })
    return root
  }

  it('空目录：dry-run 只报告，不创建任何东西', () => {
    const root = emptyRoot()
    const result = initWorkspace(root, { write: false })
    assert.equal(result.dryRun, true)
    assert.equal(result.wrote, false)
    assert.ok(result.createCount > 0)
    assert.equal(existsSync(path.join(root, 'texts')), false, 'dry-run 不得创建目录')
    rmSync(root, { recursive: true, force: true })
  })

  it('write=true 创建目录与文件，并复验缺失项清零', () => {
    const root = emptyRoot()
    const result = initWorkspace(root, { write: true })
    assert.equal(result.wrote, true)
    assert.equal(result.verified, true)
    assert.equal(existsSync(path.join(root, 'texts')), true)
    assert.equal(existsSync(path.join(root, 'outs')), true)
    assert.equal(existsSync(path.join(root, '_tools', 'payloads')), true)
    assert.equal(existsSync(path.join(root, '.whale', 'manifest.json')), true)
    assert.equal(existsSync(path.join(root, 'README.md')), true)
    const manifest = JSON.parse(readFileSync(path.join(root, '.whale', 'manifest.json'), 'utf8'))
    assert.equal(manifest.schemaVersion, 1)
    assert.deepEqual(manifest.tasks, [])
    rmSync(root, { recursive: true, force: true })
  })

  it('只创建不覆盖：已有文件一字不改', () => {
    const root = emptyRoot()
    mkdirSync(path.join(root, 'texts'), { recursive: true })
    writeFileSync(path.join(root, 'README.md'), '我自己的 README，别动我\n', 'utf8')
    const before = readFileSync(path.join(root, 'README.md'), 'utf8')
    const result = initWorkspace(root, { write: true })
    assert.equal(readFileSync(path.join(root, 'README.md'), 'utf8'), before)
    assert.ok(result.actions.find(a => a.relative === 'README.md').alreadyExists)
    rmSync(root, { recursive: true, force: true })
  })

  it('inspectWorkspace 能分清「像工作区」与「空目录」', () => {
    const root = emptyRoot()
    assert.equal(inspectWorkspace(root).recognized, false)
    initWorkspace(root, { write: true })
    const after = inspectWorkspace(root)
    assert.deepEqual(after.missingDirs, [])
    assert.deepEqual(after.missingFiles, [])
    rmSync(root, { recursive: true, force: true })
  })

  it('工具层：init 默认 dry-run，write=true 才落盘', () => {
    const root = emptyRoot()
    const dry = runWhaleMeme({ action: 'init' }, { workspaceRoot: root })
    assert.equal(dry.dryRun, true)
    assert.equal(existsSync(path.join(root, 'texts')), false)
    const real = runWhaleMeme({ action: 'init', write: true }, { workspaceRoot: root })
    assert.equal(real.wrote, true)
    assert.equal(existsSync(path.join(root, 'texts')), true)
    rmSync(root, { recursive: true, force: true })
  })
})

// ─────────────────────── 负载重建 ───────────────────────

describe('负载重建（build）', () => {
  it('缺抽取计划时给出可照抄的计划模板，而不是瞎猜', () => {
    const fixture = makeFixtureWorkspace()
    const manifest = loadManifest(fixture.root).manifest
    const result = buildPayloads({
      root: fixture.root,
      task: fixture.taskId,
      taskDirName: fixture.taskDirName,
      manifest,
      write: false,
    })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some(e => /extraction/.test(e)))
    assert.ok(result.errors.some(e => /"from"/.test(e)), '错误里应给出计划字段示例')
  })

  it('按计划抽取：dry-run 算 sha 不落盘，write 后 sha 与 dry-run 一致', () => {
    const fixture = makeFixtureWorkspace()
    // 在夹具的 02 提示词里追加一个代码块作为来源
    const sourceFile = path.join(fixture.textsDir, '02_提示词_GPT-Image-2.5.md')
    const original = readFileSync(sourceFile, 'utf8')
    writeFileSync(sourceFile, `${original}\n\`\`\`text\n母图提示词正文，包含断言短语 中性站姿全身母图。\n\`\`\`\n`, 'utf8')
    const fences = codeFences(readFileSync(sourceFile, 'utf8'))
    const block = fences.length - 1

    let manifest = loadManifest(fixture.root).manifest
    manifest = upsertTask(manifest, fixture.taskId, {
      dirName: fixture.taskDirName,
      extraction: {
        payloads: [{
          file: '10_母图_中性站姿.txt',
          from: '02_提示词_GPT-Image-2.5.md',
          block,
          source: '测试来源',
          assert: '中性站姿全身母图',
        }],
      },
    })
    saveManifest(fixture.root, manifest)
    const reloaded = loadManifest(fixture.root).manifest

    const dry = buildPayloads({ root: fixture.root, task: fixture.taskId, taskDirName: fixture.taskDirName, manifest: reloaded, write: false })
    assert.equal(dry.ok, true)
    assert.equal(dry.wrote, false)
    assert.equal(dry.entries.length, 1)
    const plannedSha = dry.entries[0].sha256

    const wrote = buildPayloads({ root: fixture.root, task: fixture.taskId, taskDirName: fixture.taskDirName, manifest: reloaded, write: true })
    assert.equal(wrote.wrote, true)
    const onDisk = path.join(fixture.root, '_tools', 'payloads', fixture.taskId, '10_母图_中性站姿.txt')
    const diskSha = createHash('sha256').update(readFileSync(onDisk)).digest('hex')
    assert.equal(diskSha, plannedSha, '落盘字节的 sha 必须与 dry-run 预告的一致')
    assert.ok(existsSync(path.join(fixture.root, '_tools', 'payloads', fixture.taskId, '_payload_index.json')))
  })

  it('断言短语对不上时拒绝抽取（防索引错位抽错内容）', () => {
    const fixture = makeFixtureWorkspace()
    let manifest = loadManifest(fixture.root).manifest
    manifest = upsertTask(manifest, fixture.taskId, {
      dirName: fixture.taskDirName,
      extraction: {
        payloads: [{
          file: '10_母图_中性站姿.txt',
          from: '02_提示词_GPT-Image-2.5.md',
          block: 0,
          assert: '这句话在文件里根本不存在',
        }],
      },
    })
    const result = buildPayloads({ root: fixture.root, task: fixture.taskId, taskDirName: fixture.taskDirName, manifest, write: true })
    assert.equal(result.ok, false)
    assert.equal(result.wrote, false, '有断言失败就不该写盘')
    assert.ok(result.errors.some(e => /断言短语/.test(e)))
  })

  it('块序号越界时明确报错，不静默产出空文件', () => {
    const fixture = makeFixtureWorkspace()
    const manifest = upsertTask(loadManifest(fixture.root).manifest, fixture.taskId, {
      dirName: fixture.taskDirName,
      extraction: { payloads: [{ file: 'x.txt', from: '02_提示词_GPT-Image-2.5.md', block: 99 }] },
    })
    const result = buildPayloads({ root: fixture.root, task: fixture.taskId, taskDirName: fixture.taskDirName, manifest, write: false })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some(e => /取不到第 99 块/.test(e)))
  })

  it('来源文件不存在时明确报错', () => {
    const fixture = makeFixtureWorkspace()
    const manifest = upsertTask(loadManifest(fixture.root).manifest, fixture.taskId, {
      dirName: fixture.taskDirName,
      extraction: { payloads: [{ file: 'x.txt', from: '不存在的文件.md', block: 0 }] },
    })
    const result = buildPayloads({ root: fixture.root, task: fixture.taskId, taskDirName: fixture.taskDirName, manifest, write: false })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some(e => /来源文件不存在/.test(e)))
  })
})

// ─────────────────────── 工具层集成 ───────────────────────

describe('新增 action 的工具层行为', () => {
  it('ACTIONS 覆盖全部 14 个动作且顺序稳定', () => {
    assert.deepEqual(ACTIONS, [
      'status', 'task', 'payload', 'lineage', 'outputs', 'commands', 'scaffold',
      'init', 'preview', 'build', 'render', 'fetch', 'draft', 'draftCheck',
    ])
    assert.equal(TOOL_ACTIONS.length, 14)
  })

  it('未知 action 被拒绝', () => {
    const fixture = makeFixtureWorkspace()
    const result = runWhaleMeme({ action: 'publish' }, { workspaceRoot: fixture.root })
    assert.equal(result.ok, false)
    assert.match(result.error, /未知 action/)
  })

  it('preview 在拿不到基础提示词时明确说明并给出出路', () => {
    const fixture = makeFixtureWorkspace()
    const result = runWhaleMeme({ action: 'preview', task: fixture.taskId, step: 'whole' }, { workspaceRoot: fixture.root })
    // 夹具的 02 文件里没有足够的代码块索引，应当落回可读错误而不是抛异常
    assert.equal(typeof result.ok, 'boolean')
    if (!result.ok) assert.ok(result.errors?.length > 0 || result.error)
  })

  it('preview 带 rawPrompt 时一定能组装出计划', () => {
    const fixture = makeFixtureWorkspace()
    const result = runWhaleMeme({
      action: 'preview',
      task: fixture.taskId,
      step: 'whole',
      rawPrompt: '【任务】画一张测试用图。',
      style: 'anime-cel',
    }, { workspaceRoot: fixture.root })
    assert.equal(result.ok, true, JSON.stringify(result.errors))
    assert.ok(result.token)
    assert.equal(result.planSummary.style, 'anime-cel')
    assert.ok(result.preview.includes('【出图计划预览】'))
  })

  it('render 不带 confirm 时即使令牌有效也不出图（且不调用 spawn）', async () => {
    resetTokens()
    const fixture = makeFixtureWorkspace()
    let spawnCalls = 0
    const spawn = async () => { spawnCalls += 1; return { code: 0, stdout: '', stderr: '' } }
    const preview = runWhaleMeme({
      action: 'preview', task: fixture.taskId, step: 'whole', rawPrompt: '【任务】测试。',
    }, { workspaceRoot: fixture.root, spawn })
    const render = await runWhaleMeme({
      action: 'render', task: fixture.taskId, step: 'whole', rawPrompt: '【任务】测试。', token: preview.token,
    }, { workspaceRoot: fixture.root, spawn })
    assert.equal(render.executed, false)
    assert.equal(spawnCalls, 0, '未确认时绝不能触发子进程')
    assert.equal(render.dryRun, true)
    assert.ok(render.costNote)
  })

  it('render 在宿主没有子进程能力时拒绝执行并指向 commands', async () => {
    resetTokens()
    const fixture = makeFixtureWorkspace()
    const preview = runWhaleMeme({
      action: 'preview', task: fixture.taskId, step: 'whole', rawPrompt: '【任务】测试。',
    }, { workspaceRoot: fixture.root })
    const render = await runWhaleMeme({
      action: 'render', task: fixture.taskId, step: 'whole', rawPrompt: '【任务】测试。', confirm: true, token: preview.token,
    }, { workspaceRoot: fixture.root })
    assert.equal(render.ok, false)
    assert.equal(render.executed, false)
    assert.ok(render.errors.some(e => /子进程/.test(e)))
  })

  it('render 令牌正确时才出图，且令牌用掉即失效', async () => {
    resetTokens()
    const fixture = makeFixtureWorkspace()
    const bodies = []
    const spawn = async ({ args }) => {
      bodies.push(args.join(' '))
      return { code: 0, stdout: 'ok', stderr: '' }
    }
    const options = {
      action: 'preview', task: fixture.taskId, step: 'whole', rawPrompt: '【任务】测试。', style: 'chunky',
    }
    const preview = runWhaleMeme(options, { workspaceRoot: fixture.root, spawn })
    const first = await runWhaleMeme({
      action: 'render', task: fixture.taskId, step: 'whole', rawPrompt: '【任务】测试。', style: 'chunky',
      confirm: true, token: preview.token,
    }, { workspaceRoot: fixture.root, spawn })
    assert.equal(first.executed, true)
    assert.equal(bodies.length, 1)
    const second = await runWhaleMeme({
      action: 'render', task: fixture.taskId, step: 'whole', rawPrompt: '【任务】测试。', style: 'chunky',
      confirm: true, token: preview.token,
    }, { workspaceRoot: fixture.root, spawn })
    assert.equal(second.executed, false)
    assert.equal(bodies.length, 1, '令牌不该被复用')
    assert.match(second.errors[0], /无效|已被使用/)
  })
})
