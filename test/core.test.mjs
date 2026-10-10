/**
 * dsh-whale-meme 单元与集成测试。
 * 运行：node --test test/
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import {
  MODEL_PROFILES,
  SILHOUETTE_ANCHORS,
  auditModelDir as core_auditModelDir,
  auditOuts,
  buildContract,
  listTasks,
  looksLikeWhaleWorkspace,
  matchTask,
  parseStoryboard,
  readManifest,
  readPngHeader,
  resolveWorkspaceRoot,
  sha256File,
  verifyPayloadIndex,
  verifyPromptLineage,
} from '../lib/core.mjs'
import { TASK_COMMANDS, buildCommandStep, resolvePython } from '../lib/commands.mjs'
import { ACTIONS, runWhaleMeme } from '../lib/tools.mjs'
import { selfCheck } from '../lib/index.mjs'
import { makeFixtureWorkspace, writeFakePng } from './helpers.mjs'

let fixture

before(() => {
  fixture = makeFixtureWorkspace()
})

after(() => {
  // 临时目录留给系统清理：不递归删除，避免测试里出现危险删除路径。
})

describe('工作区定位', () => {
  it('从子目录逐级向上探测到工作区根', () => {
    const nested = path.join(fixture.root, 'outs', fixture.taskDirName, 'gpt-image-2.5-sunburst')
    const resolved = resolveWorkspaceRoot({ startDir: nested, env: {} })
    assert.equal(resolved.root, fixture.root)
    assert.match(resolved.how, /walk-up/)
    assert.ok(resolved.evidence.length >= 2)
  })

  it('显式 root 优先，且不存在时给出可读错误', () => {
    assert.equal(resolveWorkspaceRoot({ root: fixture.root, env: {} }).root, fixture.root)
    assert.equal(resolveWorkspaceRoot({ root: fixture.root, env: {} }).how, 'config')
    assert.throws(() => resolveWorkspaceRoot({ root: path.join(fixture.root, '不存在'), env: {} }), /不存在/)
  })

  it('环境变量 DSH_WHALE_ROOT 生效', () => {
    const resolved = resolveWorkspaceRoot({ env: { DSH_WHALE_ROOT: fixture.root } })
    assert.equal(resolved.how, 'env:DSH_WHALE_ROOT')
  })

  it('空空如也的目录不会被误判为工作区', () => {
    const probe = looksLikeWhaleWorkspace(path.join(fixture.root, 'datas'))
    assert.equal(probe.ok, false)
  })

  it('探测不到时错误信息是可执行的', () => {
    assert.throws(
      () => resolveWorkspaceRoot({ startDir: path.parse(process.cwd()).root, env: {} }),
      /DSH_WHALE_ROOT/,
    )
  })
})

describe('任务发现', () => {
  it('texts/ 与 outs/ 两侧的任务被合并，outs 缺 texts 也算', () => {
    const tasks = listTasks(fixture.root)
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].id, 'task07')
    assert.equal(tasks[0].number, 7)
    assert.ok(tasks[0].textsDir && tasks[0].outsDir)
  })

  it('选择器支持 task01 / 01 / 全名，匹配不到返回 null', () => {
    const tasks = listTasks(fixture.root)
    assert.equal(matchTask(tasks, 'task07').id, 'task07')
    assert.equal(matchTask(tasks, '07').id, 'task07')
    assert.equal(matchTask(tasks, 'task07_临时测试任务').id, 'task07')
    assert.equal(matchTask(tasks, 'task99'), null)
    assert.equal(matchTask(tasks, null).id, 'task07', '只有一个任务时自动选中')
  })
})

describe('分镜逐字文案解析', () => {
  it('只取「逐字文案」围栏里的文案行，且不带标记行与加粗说明', () => {
    const parsed = parseStoryboard(fixture.root, 'task07')
    assert.equal(parsed.exists, true)
    assert.equal(parsed.ok, true)
    assert.deepEqual(parsed.lines.map(line => line.text), [
      '今天的鱼片格外松脆。',
      '鱼片竟然会反抗。',
    ])
    assert.deepEqual(parsed.boldHints, ['反抗'])
    assert.equal(parsed.lines[0].marker, '格 1（上格）')
    assert.equal(parsed.lines[1].marker, '格 2（下格）')
    assert.deepEqual(parsed.warnings, [])
  })

  it('句末缺标点会被点名', () => {
    const dir = path.join(fixture.root, 'texts', 'task08_缺标点')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, '00_分镜与文案锁定.md'), [
      '## 1. 逐字文案',
      '',
      '```text',
      '格 1（上格）',
      '这句话没有句号',
      '```',
      '',
    ].join('\n'), 'utf8')
    const parsed = parseStoryboard(fixture.root, 'task08')
    assert.equal(parsed.ok, true)
    assert.ok(parsed.warnings.some(warning => /句末标点/.test(warning)))
  })

  it('缺少分镜文件时明确报告而不是抛错', () => {
    const parsed = parseStoryboard(fixture.root, 'task09')
    assert.equal(parsed.exists, false)
    assert.equal(parsed.ok, false)
  })
})

describe('负载逐字一致性', () => {
  it('未改动时全部 ok，且能证明正文仍在来源文件里', () => {
    const verified = verifyPayloadIndex(fixture.root, 'task07')
    assert.equal(verified.ok, true)
    assert.equal(verified.entries[0].status, 'ok')
    assert.equal(verified.entries[0].matchesTextSource, true)
  })

  it('负载被手打改写 → payload-drift', () => {
    const payloadFile = path.join(fixture.root, '_tools', 'payloads', 'task07', '10_母图_中性站姿.txt')
    const original = '请把这只蓝色大肥鱼画成 2~3 头身 Q 版，保留鲸鳍状耳与卷曲呆毛。\n'
    writeFileSync(payloadFile, '我手打的另一段文字。\n', 'utf8')
    const verified = verifyPayloadIndex(fixture.root, 'task07')
    assert.equal(verified.ok, false)
    assert.equal(verified.entries[0].status, 'payload-drift')
    // 恢复成真实负载后重新核对
    writeFileSync(payloadFile, original, 'utf8')
    const restored = verifyPayloadIndex(fixture.root, 'task07')
    assert.equal(restored.ok, true)
    assert.equal(restored.entries[0].status, 'ok')
  })

  it('缺索引文件时给出 reason 而不是抛错', () => {
    const indexFile = path.join(fixture.root, '_tools', 'payloads', 'task07', '_payload_index.json')
    copyFileSync(indexFile, `${indexFile}.bak`)
    assert.equal(verifyPayloadIndex(fixture.root, 'task99').exists, false)
    assert.match(verifyPayloadIndex(fixture.root, 'task99').reason, /_payload_index/)
  })
})

describe('产物审计', () => {
  it('PNG 头解析出尺寸与透明通道', () => {
    const modelDir = path.join(fixture.root, 'outs', fixture.taskDirName, 'gpt-image-2.5-sunburst')
    writeFakePng(path.join(modelDir, '05_整图一次出图_1024x1536.png'), { width: 1024, height: 1536, colorType: 6 })
    const header = readPngHeader(path.join(modelDir, '05_整图一次出图_1024x1536.png'))
    assert.equal(header.width, 1024)
    assert.equal(header.height, 1536)
    assert.equal(header.hasAlphaChannel, true)
    assert.equal(header.colorTypeName, 'rgba')
  })

  it('推荐交付件被识别，尺寸与元数据被汇总', () => {
    const modelDir = path.join(fixture.root, 'outs', fixture.taskDirName, 'gpt-image-2.5-sunburst')
    writeFakePng(path.join(modelDir, '05_整图一次出图_1024x1536.png'), { width: 1024, height: 1536, colorType: 6 })
    // 真实客户端写的是「去掉图片扩展名 + .json」，不是 .png.json
    writeFileSync(path.join(modelDir, '05_整图一次出图_1024x1536.json'), JSON.stringify({
      model: 'gpt-image-2.5-sunburst',
      request: { size: '1024x1536', quality_echoed_by_api: 'xhigh' },
      prompt: { sha256: 'deadbeef', text: '请把这只蓝色大肥鱼画成 Q 版。' },
    }), 'utf8')
    const audit = auditOuts(fixture.root, 'task07')
    assert.equal(audit.exists, true)
    assert.equal(audit.models.length, 1)
    const model = audit.models[0]
    assert.equal(model.deliverables.length, 1)
    assert.equal(model.images[0].size, '1024x1536')
    assert.equal(model.images[0].metaModel, 'gpt-image-2.5-sunburst')
    assert.equal(model.images[0].metaSha256, 'deadbeef')
    assert.equal(model.images[0].metaQuality, 'xhigh')
    assert.equal(model.images[0].metaRequestSize, '1024x1536')
    assert.deepEqual(model.warnings, [])
  })

  it('元数据文件名按「去扩展名 + .json」口径匹配（不是 .png.json）', () => {
    const modelDir = path.join(fixture.root, 'outs', fixture.taskDirName, 'gpt-image-2.5-sunburst')
    const image = auditOuts(fixture.root, 'task07').models[0].images.find(item => item.file === '05_整图一次出图_1024x1536.png')
    assert.equal(image.metaFile, '05_整图一次出图_1024x1536.json')
    assert.equal(image.metaSha256, 'deadbeef')
    void modelDir
  })

  it('弃用件不参与推荐交付件，且不触发尺寸告警', () => {
    const modelDir = path.join(fixture.root, 'outs', fixture.taskDirName, 'gpt-image-2.5-sunburst')
    writeFakePng(path.join(modelDir, '_弃用_04_拼合_center裁切.png'), { width: 512, height: 512, colorType: 2 })
    const model = auditOuts(fixture.root, 'task07').models[0]
    const image = model.images.find(item => item.file.startsWith('_弃用'))
    assert.equal(image.deprecate, true)
    assert.equal(image.deliverable, false)
    assert.deepEqual(model.warnings, [])
  })

  it('非 PNG / 尺寸异常会被点名', () => {
    const modelDir = path.join(fixture.root, 'outs', fixture.taskDirName, 'gpt-image-2.5-sunburst')
    writeFakePng(path.join(modelDir, '99_怪尺寸.png'), { width: 777, height: 777, colorType: 2 })
    const audit = auditOuts(fixture.root, 'task07')
    assert.ok(audit.models[0].warnings.some(warning => /99_怪尺寸\.png/.test(warning)))
  })
})

describe('产物血缘', () => {
  // 血缘用例自带独立夹具：审计用例会往目录里塞怪尺寸/弃用件，
  // 共享夹具会让「计数」类断言随用例顺序漂移（历史上真的这么翻过车）。
  let lineageFixture
  before(() => {
    lineageFixture = makeFixtureWorkspace()
    const modelDir = path.join(lineageFixture.root, 'outs', lineageFixture.taskDirName, 'gpt-image-2.5-sunburst')
    writeFakePng(path.join(modelDir, '05_整图一次出图_1024x1536.png'), { width: 1024, height: 1536, colorType: 6 })
    writeFileSync(path.join(modelDir, '05_整图一次出图_1024x1536.json'), JSON.stringify({
      prompt: { sha256: 'deadbeef' },
    }), 'utf8')
  })

  it('prompt.sha256 与负载索引对不上时标 unknown-prompt', () => {
    const lineage = verifyPromptLineage(lineageFixture.root, 'task07')
    assert.equal(lineage.indexExists, true)
    assert.equal(lineage.rows.length, 1)
    assert.equal(lineage.unknown, 1)
    assert.equal(lineage.ok, false)
  })

  it('元数据索引先于图片建立：同目录 JSON 不会被漏读（含中文/下划线排序陷阱）', () => {
    // 真实工作区里 _弃用_*.png 排在数字命名之前，曾经因此把所有 PNG 误判为缺元数据。
    const modelDir = path.join(lineageFixture.root, 'outs', lineageFixture.taskDirName, 'gpt-image-2.5-sunburst')
    const audit = core_auditModelDir(modelDir)
    assert.equal(audit.images.find(image => image.file === '05_整图一次出图_1024x1536.png').metaSha256, 'deadbeef')
    assert.deepEqual(audit.warnings, [])
  })

  it('血缘对齐时 ok 为 true', () => {
    const modelDir = path.join(lineageFixture.root, 'outs', lineageFixture.taskDirName, 'gpt-image-2.5-sunburst')
    const index = JSON.parse(readFileSync(path.join(lineageFixture.root, '_tools', 'payloads', 'task07', '_payload_index.json'), 'utf8'))
    writeFileSync(path.join(modelDir, '05_整图一次出图_1024x1536.json'), JSON.stringify({
      prompt: { sha256: index.payloads[0].sha256 },
    }), 'utf8')
    const lineage = verifyPromptLineage(lineageFixture.root, 'task07')
    assert.equal(lineage.ok, true)
    assert.equal(lineage.rows[0].payload, '10_母图_中性站姿.txt')
  })
})

describe('清单', () => {
  it('没有 .whale/manifest.json 时安静返回 exists:false', () => {
    const manifest = readManifest(fixture.root)
    assert.equal(manifest.exists, false)
    assert.equal(manifest.manifest, null)
    assert.match(manifest.file, /\.whale[\\/]manifest\.json$/)
  })
})

describe('逐字复现命令', () => {
  it('步骤清单齐全', () => {
    assert.deepEqual(Object.keys(TASK_COMMANDS).sort(), ['build', 'check', 'compose', 'index', 'lower', 'mother', 'upper', 'whole'])
  })

  it('母图命令带参考立绘与 --prompt-file', () => {
    const built = buildCommandStep('mother', { root: fixture.root, task: 'task07', taskDirName: fixture.taskDirName })
    const command = built.commands[0]
    assert.match(command, /whale_image_client\.py' edit/)
    assert.match(command, /--prompt-file .*10_母图_中性站姿\.txt/)
    assert.match(command, /原始立绘_deepseek_whale\.png/)
    assert.match(command, /--size 1024x1024/)
    assert.equal(built.model, 'gpt-image-2.5-sunburst')
  })

  it('下格按模型切换措辞文件', () => {
    const img2 = buildCommandStep('lower', { root: fixture.root, task: 'task07', model: 'gpt-image-2' }).commands[0]
    const img25 = buildCommandStep('lower', { root: fixture.root, task: 'task07', model: 'gpt-image-2.5-sunburst' }).commands[0]
    assert.match(img2, /12_下格_编辑__img2\.txt/)
    assert.match(img25, /12_下格_编辑__img25\.txt/)
  })

  it('拼合命令强制 --focus top，并说明原因', () => {
    const built = buildCommandStep('compose', { root: fixture.root, task: 'task07' })
    assert.match(built.commands[0], /--focus top/)
    assert.ok(built.caveats.some(caveat => /气泡首行/.test(caveat)))
  })

  it('gpt-image-2 请求透明底时给出警告', () => {
    const built = buildCommandStep('whole', { root: fixture.root, task: 'task07', model: 'gpt-image-2', background: 'transparent' })
    const transparentCaveats = built.caveats.filter(caveat => /透明底/.test(caveat))
    assert.ok(
      transparentCaveats.some(caveat => /gpt-image-2\.5-sunburst/.test(caveat) && /不透明底/.test(caveat)),
      `应有一条说明 gpt-image-2 是不透明底、并指向 gpt-image-2.5 的提示；实际：${JSON.stringify(transparentCaveats)}`,
    )
    assert.equal(built.model, 'gpt-image-2')
    assert.equal(built.modelProfile.transparentBackground, false)
  })

  it('路径统一走单引号包裹，避免空格与中文被拆开', () => {
    const command = buildCommandStep('upper', { root: fixture.root, task: 'task07', taskDirName: fixture.taskDirName }).commands[0]
    const payloadArgument = /--prompt-file ('[^']*')/.exec(command)
    assert.ok(payloadArgument, '--prompt-file 必须存在')
    assert.ok(payloadArgument[1].startsWith("'") && payloadArgument[1].endsWith("'"))
    assert.ok(payloadArgument[1].includes('10_母图') === false, 'upper 用的是上格负载')
    assert.ok(payloadArgument[1].includes('11_上格_编辑.txt'))
  })

  it('python 解释器可解析（回退到目录里的真实路径或 python）', () => {
    const python = resolvePython()
    assert.ok(typeof python === 'string' && python.length > 0)
  })

  it('未知步骤返回可用清单', () => {
    const built = buildCommandStep('nope', { root: fixture.root, task: 'task07' })
    assert.equal(built.commands.length, 0)
    assert.ok(built.caveats.some(caveat => /未知 step/.test(caveat)))
  })
})

describe('工具动作分发', () => {
  it('未知 action 被拒绝', () => {
    const result = runWhaleMeme({ action: 'nope' }, { workspaceRoot: fixture.root })
    assert.equal(result.ok, false)
    assert.match(result.error, /未知 action/)
  })

  it('status 给出阶段归属、任务与工作区定位', () => {
    const result = runWhaleMeme({ action: 'status' }, { workspaceRoot: fixture.root })
    assert.equal(result.ok, true)
    assert.equal(result.root, fixture.root)
    const ids = result.tasks.map(task => task.id)
    assert.ok(ids.includes('task07'), `status 应包含 task07，实际：${ids.join(',')}`)
    assert.equal(result.tasks.find(task => task.id === 'task07').payloads, 1)
    assert.ok(result.taxonomy.some(stage => stage.dir === 'texts'))
    assert.deepEqual(result.silhouetteAnchors, SILHOUETTE_ANCHORS)
  })

  it('task 返回逐字行与必须加粗的字', () => {
    const result = runWhaleMeme({ action: 'task', task: 'task07' }, { workspaceRoot: fixture.root })
    assert.equal(result.ok, true)
    assert.deepEqual(result.storyboard.lines.map(line => line.text), ['今天的鱼片格外松脆。', '鱼片竟然会反抗。'])
    assert.deepEqual(result.storyboard.boldHints, ['反抗'])
  })

  it('payload / outputs / lineage / commands 都能跑通', () => {
    for (const action of ['payload', 'outputs', 'lineage']) {
      const result = runWhaleMeme({ action, task: 'task07' }, { workspaceRoot: fixture.root })
      assert.equal(result.action, action)
      assert.equal(typeof result.ok, 'boolean')
    }
    const list = runWhaleMeme({ action: 'commands' }, { workspaceRoot: fixture.root })
    assert.equal(list.ok, true)
    assert.ok(list.steps.includes('compose'))
    const one = runWhaleMeme({ action: 'commands', step: 'check', task: 'task07' }, { workspaceRoot: fixture.root })
    assert.equal(one.ok, true)
    assert.match(one.commands[0], /check_outputs\.py/)
  })

  it('工作区找不到时返回可执行的错误而不是抛异常', () => {
    const result = runWhaleMeme({ action: 'status' }, {
      workspaceRoot: null,
      cwd: path.parse(process.cwd()).root,
      env: {},
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /蓝色大肥鱼|DSH_WHALE_ROOT/)
  })

  // 注意：这条会往夹具里再加一个任务，必须放在依赖「只有一个任务」的用例之后。
  it('多个任务且未指定 task 时，报错里列出候选', () => {
    const before = runWhaleMeme({ action: 'status' }, { workspaceRoot: fixture.root }).tasks.length
    const dir = path.join(fixture.root, 'texts', 'task10_第二个')
    mkdirSync(dir, { recursive: true })
    const result = runWhaleMeme({ action: 'task' }, { workspaceRoot: fixture.root })
    assert.equal(result.ok, false)
    assert.match(result.error, /请用 task 参数指定/)
    assert.equal(runWhaleMeme({ action: 'status' }, { workspaceRoot: fixture.root }).tasks.length, before + 1)
  })
})

describe('契约注入文本', () => {
  it('包含阶段归属、三要素与硬规则，且遵守长度上限', () => {
    const contract = buildContract(fixture.root, { maxChars: 4000 })
    assert.match(contract, /工作流契约/)
    assert.match(contract, /texts\//)
    for (const anchor of SILHOUETTE_ANCHORS) assert.ok(contract.includes(anchor), `缺少锚点：${anchor}`)
    assert.match(contract, /上善无形/)
    assert.match(contract, /CC BY-NC-SA 4\.0/)
    assert.ok(contract.length <= 4000 + 40, '长度上限应生效')
    const truncated = buildContract(fixture.root, { maxChars: 200 })
    assert.match(truncated, /已截断/)
  })
})

describe('模型档案与常识守卫', () => {
  it('gpt-image-2 明确不支持透明底，2.5 系支持', () => {
    assert.equal(MODEL_PROFILES['gpt-image-2'].transparentBackground, false)
    assert.equal(MODEL_PROFILES['gpt-image-2.5-sunburst'].transparentBackground, true)
    assert.equal(MODEL_PROFILES['gpt-image-2.5-sunburst'].defaultQuality, 'xhigh')
  })
})

describe('资产自检', () => {
  it('技能正文存在且 action 列表稳定', () => {
    const check = selfCheck()
    assert.equal(check.skillFileExists, true)
    assert.equal(check.plugin, 'whale-meme')
    assert.deepEqual(ACTIONS, ['status', 'task', 'payload', 'lineage', 'outputs', 'commands', 'scaffold'])
  })
})

describe('新建任务骨架（scaffold）', () => {
  it('任务号按现有最大号递增，标题进目录名且过滤非法字符', () => {
    const fixture = makeFixtureWorkspace()
    const planned = runWhaleMeme({ action: 'scaffold', title: '程序员/AI 自嘲梗' }, { workspaceRoot: fixture.root })
    assert.equal(planned.ok, true)
    assert.equal(planned.dryRun, true)
    assert.equal(planned.wrote, false)
    assert.equal(planned.plan.taskId, 'task08')
    assert.match(planned.plan.dirName, /^task08_/)
    assert.ok(!planned.plan.dirName.includes('/'), '目录名不得含路径分隔符')
  })

  it('dry-run 不写任何文件', () => {
    const fixture = makeFixtureWorkspace()
    runWhaleMeme({ action: 'scaffold', title: '试试' }, { workspaceRoot: fixture.root })
    assert.equal(existsSync(path.join(fixture.root, 'texts', 'task08_试试')), false)
  })

  it('write=true 时创建六份文件，且内容含角色锚点与两个模型的差异', () => {
    const fixture = makeFixtureWorkspace()
    const created = runWhaleMeme({ action: 'scaffold', title: '新梗', write: true }, { workspaceRoot: fixture.root })
    assert.equal(created.ok, true)
    assert.equal(created.wrote, true)
    const dir = created.plan.textsDir
    assert.equal(existsSync(dir), true)
    for (const fileName of ['00_分镜与文案锁定.md', '01_提示词_GPT-Image-2.md', '02_提示词_GPT-Image-2.5.md', '03_无字底图与后期排版兜底.md', '04_验收清单.md', 'README.md']) {
      assert.equal(existsSync(path.join(dir, fileName)), true, `缺少 ${fileName}`)
    }
    const p2 = readFileSync(path.join(dir, '01_提示词_GPT-Image-2.md'), 'utf8')
    const p25 = readFileSync(path.join(dir, '02_提示词_GPT-Image-2.5.md'), 'utf8')
    assert.match(p2, /不支持/)
    assert.match(p25, /支持/)
    assert.match(p2, /鲸鳍状耳/)
    assert.match(readFileSync(path.join(dir, '04_验收清单.md'), 'utf8'), /上善无形/)
  })

  it('创建出来的分镜文案能被自己的解析器正确解析（骨架自洽）', () => {
    const fixture = makeFixtureWorkspace()
    const created = runWhaleMeme({ action: 'scaffold', title: '自洽性', write: true }, { workspaceRoot: fixture.root })
    const parsed = parseStoryboard(fixture.root, created.plan.taskId)
    assert.equal(parsed.exists, true)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.lines.length, 2, '骨架里应有两条文案行')
    assert.deepEqual(parsed.boldHints, ['某四字'])
  })

  it('任务号被占用时拒绝覆盖', () => {
    const fixture = makeFixtureWorkspace()
    const result = runWhaleMeme({ action: 'scaffold', title: '撞号', number: 7 }, { workspaceRoot: fixture.root })
    assert.equal(result.ok, false)
    assert.match(result.error, /已被占用/)
    assert.equal(result.wrote, false)
  })
})

describe('sha256 口径', () => {
  it('按磁盘字节计算，与 Python 端一致（不归一化换行）', () => {
    const file = path.join(fixture.root, '_tools', 'payloads', 'task07', '10_母图_中性站姿.txt')
    const expected = createHash('sha256').update(readFileSync(file)).digest('hex')
    assert.equal(sha256File(file), expected)
  })
})
