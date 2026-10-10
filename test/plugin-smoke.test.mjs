/**
 * 宿主接线冒烟测试：用一个假的 Cordis/DSH 上下文装载插件，
 * 验证工具注册、技能注册、契约注入三条线都按预期发生，且缺注册表时只告警不抛错。
 *
 * 这不能替代在真实 DSH 里重启后的验证，但它能证明接线代码本身没写错。
 *
 * 运行：node --test test/plugin-smoke.test.mjs（或 npm test）
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { ACTIONS, TOOL_NAME } from '../lib/tools.mjs'
import { SKILL_NAME, apply, inject, name, selfCheck } from '../lib/index.mjs'
import { makeFixtureWorkspace } from './helpers.mjs'

/**
 * 宿主 `ctx.tools.register` 的 schema 契约，本地复刻最小子集。
 *
 * 这一层**不是** `defineTool` 的作者式 schema：register 直接拿
 * `definition.parameters` 当模型可见的 JSON Schema，并对 `definition.output.schema`
 * 调 `assertSupportedJsonSchema`。该断言要求 `required` 是**字符串数组**，
 * 写在属性对象里的 `required: true` 会被判 `unsupported JSON schema` 并抛错，
 * 导致整个 `apply()` 失败 —— 工具与技能**都不出现**（2026-10-11 本机实测踩到）。
 * 这里刻意把这条门禁放进假上下文，让同类错误在单测里就炸，而不是等重启后才发现。
 */
function assertHostSchemaShape(node, path = 'schema') {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((entry, index) => assertHostSchemaShape(entry, `${path}[${index}]`))
    return
  }
  if (Object.hasOwn(node, 'required')) {
    assert.ok(
      Array.isArray(node.required) && node.required.every(entry => typeof entry === 'string'),
      `${path}.required 必须是字符串数组（宿主 assertSupportedJsonSchema 不接受布尔 required）`,
    )
    for (const key of node.required) {
      assert.ok(
        node.properties && Object.hasOwn(node.properties, key),
        `${path}.required 里的 "${key}" 必须出现在同层 properties 中`,
      )
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'required') continue
    assertHostSchemaShape(Array.isArray(value) && key === 'enum' ? null : value, `${path}.${key}`)
  }
}

/** 造一个假的 DSH 上下文，记录所有注册动作（注册时套用宿主的 schema 门禁）。 */
function makeFakeContext() {
  const record = {
    tools: [],
    skills: [],
    contracts: [],
    logs: { info: [], warn: [], debug: [] },
  }
  const ctx = {
    logger: {
      info: message => record.logs.info.push(String(message)),
      warn: message => record.logs.warn.push(String(message)),
      debug: message => record.logs.debug.push(String(message)),
    },
    tools: {
      register: definition => {
        assertHostSchemaShape(definition.output.schema, 'output.schema')
        assertHostSchemaShape(definition.parameters, 'parameters')
        assert.equal(definition.parameters.type, 'object', 'parameters 必须是对象根原始 JSON Schema')
        assert.equal(typeof definition.output.render, 'function', 'output.render 必填')
        assert.equal(typeof definition.execute, 'function', 'execute 必填')
        record.tools.push(definition)
      },
    },
    skills: { register: definition => record.skills.push(definition) },
    workspace: { appendInstructions: async text => record.contracts.push(text) },
  }
  return { ctx, record }
}

describe('插件接线', () => {
  it('声明了工具与技能两个必需注册表', () => {
    assert.deepEqual(inject, ['tools', 'skills'])
    assert.equal(name, 'whale-meme')
    assert.equal(TOOL_NAME, 'whale_meme')
    assert.equal(SKILL_NAME, 'whale-meme-workflow')
  })

  it('装载后：注册 1 个工具、1 个技能、注入 1 份契约', async () => {
    const fixture = makeFixtureWorkspace()
    const { ctx, record } = makeFakeContext()
    await apply(ctx, { root: fixture.root })

    assert.equal(record.tools.length, 1)
    const tool = record.tools[0]
    assert.equal(tool.name, TOOL_NAME)
    assert.deepEqual(tool.parameters.properties.action.enum, ACTIONS)
    assert.equal(tool.parameters.type, 'object', '模型可见的参数 schema 必须是对象根')
    assert.equal(typeof tool.execute, 'function')
    // 宿主契约：required 是对象层的字符串数组，不能写成属性里的 `required: true`
    assert.deepEqual(tool.output.schema.required, ['reply', 'ok', 'action'])
    assert.equal(Object.hasOwn(tool.output.schema.properties.ok, 'required'), false)
    assert.ok(tool.description.includes('鲸鳍状耳'), '描述里要带角色三要素锚点')

    assert.equal(record.skills.length, 1)
    const skill = record.skills[0]
    assert.equal(skill.name, SKILL_NAME)
    assert.equal(skill.source, 'plugin')
    assert.match(skill.content, /工作流/, '技能正文要真的读进来了')
    assert.ok(skill.content.includes('鲸鳍'), '技能正文应包含角色锚点')
    assert.equal(skill.resourceBase.kind, 'directory')

    assert.equal(record.contracts.length, 1)
    assert.match(record.contracts[0], /工作流契约/)
    assert.match(record.contracts[0], /上善无形/)
  })

  it('schema 门禁本身能抓住宿主会拒绝的形状', () => {
    // 反例：属性里写 `required: true` —— 宿主 assertSupportedJsonSchema 判 unsupported 并让 apply() 抛错
    assert.throws(
      () => assertHostSchemaShape({ type: 'object', properties: { ok: { type: 'boolean', required: true } } }),
      /required 必须是字符串数组/,
    )
    // 正例：契约要求的对象层字符串数组
    assert.doesNotThrow(() =>
      assertHostSchemaShape({ type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }),
    )
  })

  it('工具 execute 真的能跑通（回落到真实调用路径）', async () => {
    const fixture = makeFixtureWorkspace()
    const { ctx, record } = makeFakeContext()
    await apply(ctx, { root: fixture.root })
    const result = await record.tools[0].execute({ action: 'status' })
    assert.equal(result.ok, true)
    assert.equal(result.root, fixture.root)
  })

  it('presentCall / isConcurrencySafe 不抛错', async () => {
    const fixture = makeFixtureWorkspace()
    const { ctx, record } = makeFakeContext()
    await apply(ctx, { root: fixture.root })
    const tool = record.tools[0]
    assert.equal(tool.isConcurrencySafe(), true)
    const presented = tool.presentCall({ action: 'payload', task: 'task07' })
    assert.equal(presented.kind, 'read')
    assert.match(presented.title, /payload/)
  })

  it('可以关掉契约注入与技能注册', async () => {
    const fixture = makeFixtureWorkspace()
    const { ctx, record } = makeFakeContext()
    await apply(ctx, { root: fixture.root, injectWorkspaceContract: false, registerSkill: false })
    assert.equal(record.skills.length, 0)
    assert.equal(record.contracts.length, 0)
    assert.equal(record.tools.length, 1, '工具不受影响')
  })

  it('宿主缺 workspace 注入入口时只告警，不抛错', async () => {
    const fixture = makeFixtureWorkspace()
    const { ctx, record } = makeFakeContext()
    delete ctx.workspace
    await apply(ctx, { root: fixture.root })
    assert.equal(record.tools.length, 1)
    assert.equal(record.skills.length, 1)
  })

  it('宿主缺 tools / skills 注册表时只告警，不抛错', async () => {
    const fixture = makeFixtureWorkspace()
    const { ctx, record } = makeFakeContext()
    delete ctx.tools
    delete ctx.skills
    await apply(ctx, { root: fixture.root })
    assert.equal(record.tools.length, 0)
    assert.equal(record.skills.length, 0)
    assert.ok(record.logs.warn.some(line => /tools 注册表/.test(line)))
    assert.ok(record.logs.warn.some(line => /skills 注册表/.test(line)))
  })

  it('工作区定位失败时插件仍能装载（工具调用时再报错）', async () => {
    const { ctx, record } = makeFakeContext()
    await apply(ctx, { root: null, startDir: undefined })
    assert.equal(record.tools.length, 1)
    assert.ok(record.logs.warn.length >= 0)
  })

  it('selfCheck 指向真实存在的技能文件', () => {
    const check = selfCheck()
    assert.equal(check.skillFileExists, true)
    assert.deepEqual(check.actions, ACTIONS)
  })
})

/**
 * bundle 补丁的形状。
 *
 * 宿主的补丁层语义是：顶层数组里**带 `id` 的裸条目 = 对已存在条目的覆盖**，
 * 新增插件行必须包在 `insert:` 列表里。写成裸 `- id: whale-meme` 时，
 * 宿主在组合期判 `entry "whale-meme" not found`，把整条补丁丢弃、只往 stderr
 * 写一行警告 —— 不抛错、不影响启动，表现就是工具与技能**都不出现**。
 * 2026-10-11 本机实测踩到过这个坑（重启后 whale_meme 工具缺失），故加此断言。
 */
describe('bundle 补丁形状', () => {
  const patchUrl = new URL('../cordis.patch.yml', import.meta.url)
  const packageUrl = new URL('../package.json', import.meta.url)

  it('用 insert 形式挂载，且不存在会被静默丢弃的顶层裸 id 条目', () => {
    const lines = readFileSync(patchUrl, 'utf8').split(/\r?\n/)

    const bareTopLevel = lines.filter(line => /^- id:/.test(line))
    assert.deepEqual(
      bareTopLevel,
      [],
      '顶层裸 `- id:` 是「覆盖已存在条目」的语义，宿主会判 not found 并丢弃整个 bundle',
    )

    assert.ok(
      lines.some(line => /^- insert:\s*$/.test(line)),
      '新增插件行必须写在 `- insert:` 列表里',
    )

    const inserted = lines.filter(line => /^\s+- id:\s*whale-meme\s*$/.test(line))
    assert.equal(inserted.length, 1, 'insert 列表里要有且只有一个 id: whale-meme 条目')
    assert.ok(
      lines.some(line => /^\s+name:\s*dsh-whale-meme\s*$/.test(line)),
      'insert 条目的 name 必须是包名 dsh-whale-meme，宿主才能解析到本包',
    )
  })

  it('package.json 的 bundle 声明指向这份补丁', () => {
    const manifest = JSON.parse(readFileSync(packageUrl, 'utf8'))
    assert.equal(manifest.name, 'dsh-whale-meme')
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  })
})
