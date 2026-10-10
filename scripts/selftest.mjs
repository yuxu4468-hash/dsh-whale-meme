#!/usr/bin/env node
/**
 * selftest.mjs —— 对**真实工作区**跑一遍 whale_meme 的全部 action，输出可审计报告。
 *
 * 这不是单元测试（单元测试在 test/ 下用夹具跑）；它证明的是
 * 「这个插件在 F:\whale meme 的真实数据上结论正确」。
 *
 * 用法：
 *   node scripts/selftest.mjs                 # 自动定位工作区
 *   node scripts/selftest.mjs --root "F:\whale meme"
 *   node scripts/selftest.mjs --json          # 只输出 JSON
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { resolveWorkspaceRoot } from '../lib/core.mjs'
import { resolvePython } from '../lib/commands.mjs'
import { ACTIONS, runWhaleMeme } from '../lib/tools.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const rootArgIndex = argv.indexOf('--root')
const rootArg = rootArgIndex >= 0 ? argv[rootArgIndex + 1] : null

function line(char = '─', width = 78) {
  return char.repeat(width)
}

function heading(text) {
  return `\n${line()}\n${text}\n${line()}`
}

let root
try {
  root = resolveWorkspaceRoot({ root: rootArg }).root
} catch (error) {
  console.error(`✗ ${error.message}`)
  process.exit(2)
}

const context = { workspaceRoot: root }
const report = { root, actions: {}, checks: [], ok: true }

function record(name, ok, detail) {
  report.checks.push({ name, ok, detail })
  if (!ok) report.ok = false
}

// ── 1. 全部 action 都能跑通 ──────────────────────────────────────────────
const status = runWhaleMeme({ action: 'status' }, context)
report.actions.status = status
record('status 返回工作区结构', status.ok === true, status.error ?? `${status.tasks?.length ?? 0} 个任务`)
record('阶段目录齐备', (status.taxonomy ?? []).every(stage => stage.exists), (status.taxonomy ?? []).filter(s => !s.exists).map(s => s.dir).join(',') || '全部存在')

const tasks = status.tasks ?? []
if (tasks.length === 0) {
  record('至少有一个任务', false, '工作区里没有 taskNN_* 目录')
}

for (const task of tasks) {
  const taskReport = runWhaleMeme({ action: 'task', task: task.id }, context)
  const payloadReport = runWhaleMeme({ action: 'payload', task: task.id }, context)
  const lineageReport = runWhaleMeme({ action: 'lineage', task: task.id }, context)
  const outputsReport = runWhaleMeme({ action: 'outputs', task: task.id }, context)
  report.actions[task.id] = { task: taskReport, payload: payloadReport, lineage: lineageReport, outputs: outputsReport }

  const prefix = `[${task.id}]`
  record(`${prefix} 提示词五件套齐全`, taskReport.missingFiles.length === 0, taskReport.missingFiles.join(', ') || '5/5')
  record(
    `${prefix} 逐字文案可解析`,
    taskReport.storyboard.ok === true,
    taskReport.storyboard.lines.map(l => l.text).join(' / ').slice(0, 80),
  )
  record(
    `${prefix} 负载仍与 texts/ 逐字一致`,
    payloadReport.ok === true,
    payloadReport.entries.map(e => `${e.file}=${e.status}`).join(' '),
  )
  record(
    `${prefix} 产物元数据 sha256 ↔ 负载索引对齐`,
    lineageReport.ok === true,
    lineageReport.ok
      ? `${lineageReport.rows.length} 张产物全部对得上索引（其中 ${lineageReport.summary.missingMetadata} 张为无元数据的本地拼合件）`
      : `对不上索引：${lineageReport.summary.unaligned.join('、')}`,
  )
  record(
    `${prefix} 每个模型都有推荐交付件`,
    (outputsReport.models ?? []).every(model => model.images.some(image => image.deliverable)),
    (outputsReport.models ?? []).map(m => `${m.model}:${m.images.filter(i => i.deliverable).length}`).join(' '),
  )
}

const commands = runWhaleMeme({ action: 'commands' }, context)
record('commands 列出全部步骤', Array.isArray(commands.steps) && commands.steps.length >= 8, (commands.steps ?? []).join(', '))
const python = resolvePython()
record('出图客户端存在', existsSync(path.join(root, '_tools', 'whale_image_client.py')), path.join(root, '_tools', 'whale_image_client.py'))
record('Python 解释器可用', python !== 'python' ? existsSync(python) : true, python)

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.ok ? 0 : 1)
}

// ── 2. 人读报告 ─────────────────────────────────────────────────────────
console.log(heading('「蓝色大肥鱼」表情包工作区 · 插件自检'))
console.log(`工作区：${root}`)
console.log(`任务数：${tasks.length}（${tasks.map(t => t.id).join(', ') || '无'}）`)

for (const task of tasks) {
  const per = report.actions[task.id]
  console.log(heading(`${task.id} · ${task.title}`))

  console.log('\n■ 逐字文案（唯一权威文本源）')
  console.log(`  文件：${per.task.storyboard.file}`)
  for (const item of per.task.storyboard.lines) {
    console.log(`  ${item.marker ? `[${item.marker}] ` : ''}${item.text}`)
  }
  if (per.task.storyboard.boldHints.length > 0) {
    console.log(`  必须加粗（且只有这些）：${per.task.storyboard.boldHints.join('、')}`)
  }

  console.log('\n■ 投喂负载（是否仍与 texts/ 逐字一致）')
  for (const entry of per.payload.entries) {
    const mark = entry.status === 'ok' ? '✓' : '✗'
    console.log(`  ${mark} ${entry.file.padEnd(26)} ${String(entry.actualSha256).slice(0, 12)}  ${entry.status}`)
    if (entry.status !== 'ok') console.log(`      来源：${entry.source}`)
  }

  console.log('\n■ 产物血缘（产物 ↔ 投喂负载）')
  for (const row of per.lineage.rows) {
    const mark = row.status === 'ok' ? '✓' : row.status === 'no-metadata' ? '·' : '✗'
    console.log(`  ${mark} ${row.model.padEnd(22)} ${row.image.padEnd(34)} ${row.payload ?? row.status}`)
  }

  console.log('\n■ 产物清单')
  for (const model of per.outputs.models ?? []) {
    console.log(`  ${model.model}（${model.images.length} 张，checks.json：${model.hasChecks ? '有' : '无'}）`)
    for (const image of model.images) {
      const flags = [image.deliverable ? '★交付' : null, image.deprecate ? '弃用' : null, image.alphaChannel ? 'alpha' : null].filter(Boolean).join(' ')
      console.log(`    ${image.file.padEnd(36)} ${String(image.size).padEnd(11)} ${String(image.bytesHuman).padStart(9)} ${flags}`)
    }
    for (const warning of model.warnings) console.log(`    ⚠ ${warning}`)
  }
}

console.log(heading('自检结论'))
for (const check of report.checks) {
  console.log(`  ${check.ok ? '✓' : '✗'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`)
}
const failed = report.checks.filter(check => !check.ok)
console.log(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 项未通过`}（共 ${report.checks.length} 项）`)
process.exit(report.ok ? 0 : 1)
