/**
 * 宿主接线冒烟测试：用一个假的 Cordis/DSH 上下文装载插件，
 * 验证工具注册、技能注册、契约注入三条线都按预期发生，且缺注册表时只告警不抛错。
 *
 * 这不能替代在真实 DSH 里重启后的验证，但它能证明接线代码本身没写错。
 *
 * 运行：node --test test/plugin-smoke.test.mjs（或 npm test）
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ACTIONS, TOOL_NAME } from '../lib/tools.mjs'
import { SKILL_NAME, apply, inject, name, selfCheck } from '../lib/index.mjs'
import { makeFixtureWorkspace } from './helpers.mjs'

/** 造一个假的 DSH 上下文，记录所有注册动作。 */
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
    tools: { register: definition => record.tools.push(definition) },
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
    assert.deepEqual(tool.parameters.action.enum, ACTIONS)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(tool.output.schema.properties.ok.required, true)
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
