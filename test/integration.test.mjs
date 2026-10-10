/**
 * 真实工作区集成测试。
 *
 * 与 core.test.mjs 的区别：那些用例跑在临时夹具上，验证「逻辑对不对」；
 * 这里跑在真实工作区上，验证「对这个工作区的数据下的结论对不对」。
 *
 * 工作区不在时自动跳过（CI / 换机器不会红）。
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { resolveWorkspaceRoot } from '../lib/core.mjs'
import { runWhaleMeme } from '../lib/tools.mjs'

let root = null
try {
  root = resolveWorkspaceRoot({ root: process.env.DSH_WHALE_ROOT ?? null }).root
} catch {
  root = null
}

const skip = root === null ? '真实工作区不在这台机器上，跳过' : false

describe('真实工作区集成', () => {
  it('能定位到工作区', { skip }, () => {
    assert.ok(existsSync(path.join(root, '_tools', 'whale_image_client.py')))
  })

  it('status 报告阶段目录齐备', { skip }, () => {
    const result = runWhaleMeme({ action: 'status' }, { workspaceRoot: root })
    assert.equal(result.ok, true)
    for (const stage of result.taxonomy) {
      assert.equal(stage.exists, true, `阶段目录缺失：${stage.dir}`)
    }
  })

  it('每个任务的提示词五件套齐全', { skip }, () => {
    const tasks = runWhaleMeme({ action: 'status' }, { workspaceRoot: root }).tasks
    assert.ok(tasks.length > 0, '工作区里应有至少一个任务')
    for (const task of tasks) {
      const detail = runWhaleMeme({ action: 'task', task: task.id }, { workspaceRoot: root })
      assert.deepEqual(detail.missingFiles, [], `${task.id} 缺少文件`)
    }
  })

  it('投喂负载仍与 texts/ 逐字一致（含正文出现于来源文件）', { skip }, () => {
    const tasks = runWhaleMeme({ action: 'status' }, { workspaceRoot: root }).tasks
    for (const task of tasks) {
      const payload = runWhaleMeme({ action: 'payload', task: task.id }, { workspaceRoot: root })
      if (!payload.indexExists) continue
      const bad = payload.entries.filter(entry => entry.status !== 'ok')
      assert.deepEqual(bad.map(entry => `${entry.file}:${entry.status}`), [], `${task.id} 负载漂移`)
    }
  })

  it('没有任何产物对不上负载索引', { skip }, () => {
    const tasks = runWhaleMeme({ action: 'status' }, { workspaceRoot: root }).tasks
    for (const task of tasks) {
      const lineage = runWhaleMeme({ action: 'lineage', task: task.id }, { workspaceRoot: root })
      if (lineage.rows.length === 0) continue
      const unknown = lineage.rows.filter(row => row.status === 'unknown-prompt')
      assert.deepEqual(unknown.map(row => `${row.model}/${row.image}`), [], `${task.id} 有产物对不上负载索引`)
      // 缺元数据的只允许是本地拼合产物（compose_panels.py 不写元数据）
      const missing = lineage.rows.filter(row => row.status === 'no-metadata')
      const suspicious = missing.filter(row => !/^04_拼合/.test(row.image))
      assert.deepEqual(suspicious.map(row => `${row.model}/${row.image}`), [], `${task.id} 有非拼合产物缺元数据`)
    }
  })

  it('commands 生成的命令里路径都带单引号且指向工作区', { skip }, () => {
    for (const step of ['mother', 'upper', 'lower', 'whole', 'compose', 'check']) {
      const built = runWhaleMeme({ action: 'commands', step }, { workspaceRoot: root })
      assert.equal(built.ok, true, `step=${step} 失败`)
      assert.ok(built.commands[0].includes("'"), `step=${step} 命令缺少引号包裹`)
      assert.ok(built.commands[0].includes(path.basename(root)) || built.commands[0].includes(root), `step=${step} 命令未指向工作区`)
    }
  })
})
