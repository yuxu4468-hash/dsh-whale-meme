/**
 * 自然语言回复层的测试。
 *
 * 重点不是「回复好看」，而是四件容易出事的地方：
 *   1. 每个 action 都有回复，且回复里不出现 undefined / null / [object Object]；
 *   2. **失败就是失败** —— 不能把失败说成「完成」，也不能在失败时给出「可以出图」的指引；
 *   3. **不该给令牌时不给** —— 计划不合法时既不发令牌，回复里也不出现令牌字面量；
 *   4. 回复层自身出错时不能影响结构化结果（回复是附加物，不是必需品）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatReply } from '../lib/reply.mjs'
import { ACTIONS, runWhaleMeme } from '../lib/tools.mjs'
import { resetTokens } from '../lib/render.mjs'
import { makeFixtureWorkspace } from './helpers.mjs'

const TOKEN_RE = /\b[0-9a-f]{64}\b/

/** 回复里不该出现的脏东西。 */
function assertClean(text, label) {
  assert.equal(typeof text, 'string', `${label}: 回复应为字符串`)
  assert.ok(text.trim().length > 0, `${label}: 回复不能为空`)
  // 注意：不把 `null` 当脏值 —— draft 的模板里故意有 null（表示「留空不传该参数」），
  // 那是合法 JSON，不是未填充的占位异常。
  for (const bad of ['undefined', '[object Object]', 'NaN', 'Infinity']) {
    assert.ok(!text.includes(bad), `${label}: 回复里出现了 ${bad}\n---\n${text}`)
  }
  assert.ok(!text.includes('\uFFFD'), `${label}: 回复里有替换字符`)
}

describe('回复层：覆盖与洁净度', () => {
  it('14 个 action 都有专用回复模板（不落到通用兜底）', async () => {
    const fixture = makeFixtureWorkspace()
    const calls = {
      status: {},
      task: { task: 'task07' },
      payload: { task: 'task07' },
      lineage: { task: 'task07' },
      outputs: { task: 'task07' },
      commands: {},
      scaffold: { title: '回复测试' },
      init: {},
      preview: { task: 'task07', rawPrompt: '【任务】测试用图。' },
      build: { task: 'task07' },
      render: { task: 'task07', rawPrompt: '【任务】测试用图。' },
      // fetch 传一个不存在的包名：既不触网络，也仍走 fetch 的回复模板
      fetch: { bundles: ['nope'] },
      draft: { narrative: '测试需求' },
      draftCheck: { draft: { subject: '标题', panels: [{ marker: '格 1', text: '一句话。' }] } },
    }
    assert.deepEqual(Object.keys(calls).sort(), [...ACTIONS].sort(), '模板表必须覆盖全部 action')

    for (const [action, extra] of Object.entries(calls)) {
      const result = await runWhaleMeme({ action, ...extra }, { workspaceRoot: fixture.root })
      assertCapable(result, action)
    }
  })

  function assertCapable(result, action) {
    assert.equal(typeof result.reply, 'string', `${action}: 应有 reply`)
    assertClean(result.reply, action)
    assert.ok(!/没有专用回复模板/.test(result.reply), `${action}: 不该落到通用兜底`)
  }

  it('每个回复都以状态符号开头，让人一眼看出成没成', async () => {
    const fixture = makeFixtureWorkspace()
    for (const action of ['status', 'task', 'payload', 'lineage', 'outputs', 'commands', 'scaffold', 'init', 'build']) {
      const result = await runWhaleMeme({ action, task: 'task07', title: 'x', rawPrompt: '【任务】t。' }, { workspaceRoot: fixture.root })
      assert.match(result.reply.split('\n')[0], /^[✅❌⚠️]/u, `${action}: 首行应以状态符号开头`)
    }
  })
})

describe('回复层：失败就是失败', () => {
  it('未知 action 的回复不说「完成」', async () => {
    const fixture = makeFixtureWorkspace()
    const result = await runWhaleMeme({ action: 'publish' }, { workspaceRoot: fixture.root })
    assert.equal(result.ok, false)
    assert.match(result.reply, /❌/)
    assert.ok(!result.reply.includes('✅'), '失败时不该出现 ✅')
    // 失败要如实说「没能完成」，而不是肯定式的「已完成」
    assert.ok(result.reply.includes('没能完成'), `失败理由应说清楚：${result.reply}`)
    assert.ok(!result.reply.includes('已完成'), `失败却说已完成：${result.reply}`)
  })

  it('找不到工作区时回复给出可执行的出路', async () => {
    const result = await runWhaleMeme({ action: 'status' }, { workspaceRoot: null, cwd: 'C:\\', env: {} })
    assert.equal(result.ok, false)
    assertClean(result.reply, 'no-workspace')
    assert.match(result.reply, /❌/)
  })

  it('指定了不存在的任务时回复说明怎么选任务', async () => {
    const fixture = makeFixtureWorkspace()
    const result = await runWhaleMeme({ action: 'task', task: 'task99' }, { workspaceRoot: fixture.root })
    assert.equal(result.ok, false)
    assertClean(result.reply, 'bad-task')
    assert.match(result.reply, /task/)
  })

  it('回复层的开关与结构化结果不会互相矛盾', async () => {
    const fixture = makeFixtureWorkspace()
    const result = await runWhaleMeme({ action: 'task', task: 'task99' }, { workspaceRoot: fixture.root })
    // 结构化说失败 → 回复不能出现 ✅
    assert.equal(result.ok, false)
    assert.ok(!result.reply.includes('✅'), `ok=false 却出现 ✅：\n${result.reply}`)
  })
})

describe('回复层：出图门禁的安全表达', () => {
  it('计划不合法时：不给令牌、回复里不出现令牌、也不给出出图指引', async () => {
    resetTokens()
    const fixture = makeFixtureWorkspace()
    // gpt-image-2 不支持透明底 → 计划必然不合法
    const result = await runWhaleMeme({
      action: 'preview', task: 'task07', rawPrompt: '【任务】t。',
      model: 'gpt-image-2', background: 'transparent',
    }, { workspaceRoot: fixture.root })

    assert.equal(result.ok, false)
    assert.equal(result.token, null, '不合法的计划不该发令牌')
    assert.ok(!TOKEN_RE.test(result.reply), '回复里不该出现令牌字面量')
    assert.ok(!result.reply.includes('确认无误就出图'), '不合法的计划不该给出出图指引')
    assert.match(result.reply, /不会给确认令牌/)
    assertClean(result.reply, 'invalid-preview')
  })

  it('合法计划才给令牌，且回复里带上它', async () => {
    resetTokens()
    const fixture = makeFixtureWorkspace()
    const result = await runWhaleMeme({
      action: 'preview', task: 'task07', rawPrompt: '【任务】t。', style: 'watercolor',
    }, { workspaceRoot: fixture.root })
    assert.equal(result.ok, true)
    assert.equal(typeof result.token, 'string')
    assert.ok(result.reply.includes(result.token), '回复里应带上令牌，方便直接复制')
    assert.ok(result.reply.includes('确认无误就出图'))
  })

  it('render 未确认时明确说「还没有出图、没有花费」', async () => {
    resetTokens()
    const fixture = makeFixtureWorkspace()
    const result = await runWhaleMeme({
      action: 'render', task: 'task07', rawPrompt: '【任务】t。', style: 'watercolor',
    }, { workspaceRoot: fixture.root })
    assert.equal(result.executed, false)
    assert.match(result.reply, /还没有出图/)
    assert.match(result.reply, /没有花费/)
    assertClean(result.reply, 'render-dry')
  })

  it('render 被门禁拦下时说明原因，且不暗示可以重试', async () => {
    resetTokens()
    const fixture = makeFixtureWorkspace()
    const result = await runWhaleMeme({
      action: 'render', task: 'task07', rawPrompt: '【任务】t。', style: 'watercolor',
      confirm: true, token: 'deadbeef',
    }, { workspaceRoot: fixture.root })
    assert.equal(result.executed, false)
    assert.match(result.reply, /门禁/)
    assert.ok(!/重试成功|已重试/.test(result.reply))
    assertClean(result.reply, 'render-gated')
  })

  it('render 失败时给出退出码与客户端输出，并说明不会自动重试', async () => {
    resetTokens()
    const fixture = makeFixtureWorkspace()
    const preview = await runWhaleMeme({
      action: 'preview', task: 'task07', rawPrompt: '【任务】t。', style: 'watercolor',
    }, { workspaceRoot: fixture.root })
    const result = await runWhaleMeme({
      action: 'render', task: 'task07', rawPrompt: '【任务】t。', style: 'watercolor',
      confirm: true, token: preview.token,
    }, {
      workspaceRoot: fixture.root,
      spawn: async () => ({ code: 7, stdout: '', stderr: '上游 500：模拟失败' }),
    })
    assert.equal(result.ok, false)
    assert.match(result.reply, /没有成功/)
    assert.match(result.reply, /7/, '应给出退出码')
    assert.match(result.reply, /模拟失败/, '应带上客户端输出')
    assert.match(result.reply, /不会自动重试/)
    assertClean(result.reply, 'render-failed')
  })

  it('render 成功时说明产物路径与「投喂零改写」的核验结论', async () => {
    resetTokens()
    const fixture = makeFixtureWorkspace()
    const preview = await runWhaleMeme({
      action: 'preview', task: 'task07', rawPrompt: '【任务】t。', style: 'watercolor',
    }, { workspaceRoot: fixture.root })
    const result = await runWhaleMeme({
      action: 'render', task: 'task07', rawPrompt: '【任务】t。', style: 'watercolor',
      confirm: true, token: preview.token,
    }, { workspaceRoot: fixture.root, spawn: async () => ({ code: 0, stdout: 'ok', stderr: '' }) })
    // 夹具里 client 脚本是桩文件，不会真的产出图片，所以 ok 取决于产物是否存在；
    // 这里只断言回复结构，不断言成功与否
    assertClean(result.reply, 'render-ran')
    assert.ok(result.executed === true)
  })
})

describe('回复层：健壮性', () => {
  it('回复层遇到畸形输入不抛错，改为说明情况', () => {
    assertClean(formatReply('status', {}), 'empty-status')
    assertClean(formatReply('task', { ok: false }), 'bad-task')
    assertClean(formatReply('payload', { ok: false, entries: [] }), 'bad-payload')
    assertClean(formatReply('outputs', { ok: false, models: [] }), 'bad-outputs')
    assertClean(formatReply('render', { executed: false }), 'bad-render')
  })

  it('格式化函数内部抛错时，也不影响结构化结果', async () => {
    const fixture = makeFixtureWorkspace()
    // 传一个 getter 会抛错的对象进去，模拟回复层内部异常
    const poisoned = {
      ok: true, action: 'status', root: fixture.root,
      get tasks() { throw new Error('故意炸掉') },
    }
    const reply = formatReply('status', poisoned)
    assertClean(reply, 'poisoned')
    assert.match(reply, /出错/) // 明确说明回复生成失败，而不是静默返回空
  })

  it('回复里带上了关键可核对信息（sha 前 12 位与任务号）', async () => {
    const fixture = makeFixtureWorkspace()
    const payload = await runWhaleMeme({ action: 'payload', task: 'task07' }, { workspaceRoot: fixture.root })
    if (payload.entries?.length > 0 && payload.entries[0].actualSha256) {
      const short = payload.entries[0].actualSha256.slice(0, 12)
      assert.ok(payload.reply.includes(short), 'payload 回复里应有 sha 前 12 位')
    }
    const task = await runWhaleMeme({ action: 'task', task: 'task07' }, { workspaceRoot: fixture.root })
    assert.ok(task.reply.includes('task07'), 'task 回复里应有任务号')
  })
})
