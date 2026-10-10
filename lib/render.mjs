/**
 * dsh-whale-meme / render —— 「确认后直接出图」。
 *
 * 出图是**有费用、有副作用**的动作，所以这一层的设计原则是「默认什么都不做」：
 *
 *   1. `render` 不带 `confirm: true` 时**只出计划**，与 `preview` 等价；
 *   2. 真出图必须同时满足：`confirm: true` + 一个**最近由 preview 发出的、与当前计划完全一致的令牌**；
 *   3. 令牌一次性使用，用过即失效；计划只要有一个字段变了，令牌就对不上；
 *   4. 每次调用最多出一张图（本项目实测每张 20~130 秒、按张计费），批次由调用方一张张来。
 *
 * 真正的 HTTP 细节与重试、签名 URL 过期、浏览器 UA 这些坑，全部交给工作区既有的
 * `_tools/whale_image_client.py`，插件不重复实现 —— 那份脚本是工作区自己的资产，插件只读。
 *
 * @module dsh-whale-meme/render
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { normalizeText } from './core.mjs'
import { planToken } from './requirements.mjs'

/** 预览令牌的有效期（毫秒）。超时后必须重新预览。 */
export const TOKEN_TTL_MS = 10 * 60 * 1000

/** 已发出的预览令牌：token → { at, planDigest }。模块级，随宿主进程存活。 */
const issuedTokens = new Map()

/** 记一个预览令牌。 */
export function issueToken(token, plan) {
  issuedTokens.set(token, { at: Date.now(), planDigest: digestOf(plan) })
  // 顺手清掉过期项，避免无限增长
  const now = Date.now()
  for (const [key, value] of issuedTokens) if (now - value.at > TOKEN_TTL_MS) issuedTokens.delete(key)
}

/** 计划的指纹：用于判断「确认的是不是同一份计划」。 */
function digestOf(plan) {
  return planToken(plan)
}

/**
 * 校验确认令牌。
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkToken(token, plan) {
  if (!token) return { ok: false, reason: '缺少 token：请先调用 whale_meme(action="preview")，把返回里的确认令牌原样带回' }
  const record = issuedTokens.get(token)
  if (!record) return { ok: false, reason: '令牌无效或已被使用：请重新 preview 取新令牌（令牌一次性）' }
  if (Date.now() - record.at > TOKEN_TTL_MS) {
    issuedTokens.delete(token)
    return { ok: false, reason: `令牌已过期（超过 ${Math.round(TOKEN_TTL_MS / 60000)} 分钟）：请重新 preview` }
  }
  if (record.planDigest !== digestOf(plan)) {
    return { ok: false, reason: '令牌与当前计划不一致：计划在预览之后发生了改动，请重新 preview' }
  }
  return { ok: true }
}

/** 消耗一个令牌（一次性）。 */
export function consumeToken(token) {
  issuedTokens.delete(token)
}

/** 当前有多少个未过期令牌（调试与测试用）。 */
export function liveTokenCount() {
  const now = Date.now()
  for (const [key, value] of issuedTokens) if (now - value.at > TOKEN_TTL_MS) issuedTokens.delete(key)
  return issuedTokens.size
}

/** 清空令牌（测试用）。 */
export function resetTokens() {
  issuedTokens.clear()
}

/**
 * 把计划变成一次客户端调用的参数。
 * 提示词写到独立文件：一律用 `--prompt-file`，不在命令行里内联中文。
 */
export function planToInvocation(plan, { pythonPath, clientScript }) {
  const promptFile = path.join(
    plan.outputDir,
    '_prompt',
    `${path.basename(plan.outputs[0].file, '.png')}__${plan.prompt.sha256.slice(0, 8)}.txt`,
  )
  const command = plan.step === 'whole' ? 'gen' : 'edit'
  const args = [
    clientScript,
    command,
    '--model', plan.model,
    '--prompt-file', promptFile,
    '--out', plan.outputs[0].absolutePath,
    '--size', plan.size,
    '--quality', plan.quality,
    '--timeout', '900',
  ]
  if (plan.background) args.push('--background', plan.background)
  for (const image of [plan.inputImage].filter(Boolean)) args.push('--image', image)
  return { pythonPath, args, promptFile, promptBytes: Buffer.from(plan.prompt.text, 'utf8'), outPath: plan.outputs[0].absolutePath }
}

/**
 * 执行一份出图计划。
 *
 * @param {object} input
 * @param {object} input.plan - 由 buildRenderPlan 产出的计划
 * @param {string} input.pythonPath - Python 解释器
 * @param {string} input.clientScript - `_tools/whale_image_client.py` 的绝对路径
 * @param {(spec: {program: string, args: string[], cwd?: string, timeoutMs?: number}) => Promise<{code: number|null, stdout: string, stderr: string}>} input.spawn
 * @returns {Promise<object>} 结果；含产物路径、sha256 与客户端报告
 */
export async function executeRender(input) {
  const { plan, pythonPath, clientScript, spawn } = input
  const errors = []

  if (!existsSync(clientScript)) errors.push(`出图客户端不存在：${clientScript}`)
  if (!plan.inputImage && plan.step !== 'whole') errors.push(`step=${plan.step} 需要输入图，但没有提供`)
  if (plan.inputImage && !existsSync(plan.inputImage)) errors.push(`输入图不存在：${plan.inputImage}`)
  if (typeof spawn !== 'function') errors.push('宿主没有可用的子进程能力（subprocess），无法执行出图')
  if (errors.length > 0) return { ok: false, errors, plan, executed: false }

  const invocation = planToInvocation(plan, { pythonPath, clientScript })
  mkdirSync(path.dirname(invocation.promptFile), { recursive: true })
  writeFileSync(invocation.promptFile, invocation.promptBytes)

  // 写盘后再核一次：磁盘字节的 sha256 必须与计划里记录的一致
  const onDiskSha = createHash('sha256').update(readFileSync(invocation.promptFile)).digest('hex')
  if (onDiskSha !== plan.prompt.sha256) {
    return {
      ok: false,
      executed: false,
      plan,
      errors: [`提示词落盘后 sha256 与计划不一致（计划 ${plan.prompt.sha256.slice(0, 12)} / 磁盘 ${onDiskSha.slice(0, 12)}），已中止出图`],
      promptFile: invocation.promptFile,
    }
  }

  const started = Date.now()
  const result = await spawn({
    program: pythonPath,
    args: invocation.args,
    cwd: path.dirname(clientScript),
    timeoutMs: 900_000,
  })
  const elapsedMs = Date.now() - started

  const metaFile = invocation.outPath.replace(/\.png$/i, '.json')
  let meta = null
  if (existsSync(metaFile)) {
    try {
      meta = JSON.parse(normalizeText(readFileSync(metaFile, 'utf8')))
    } catch {
      meta = { parseError: true }
    }
  }

  const produced = existsSync(invocation.outPath)
  const lineage = meta?.prompt?.sha256 ?? null
  return {
    ok: result.code === 0 && produced,
    executed: true,
    plan,
    exitCode: result.code,
    elapsedMs,
    promptFile: invocation.promptFile,
    promptSha256OnDisk: onDiskSha,
    output: produced
      ? { path: invocation.outPath, bytes: readFileSync(invocation.outPath).length, metaFile: existsSync(metaFile) ? metaFile : null }
      : null,
    meta: meta
      ? {
        model: meta.model ?? meta.request?.model ?? null,
        size: meta.response?.size ?? null,
        quality: meta.request?.quality_echoed_by_api ?? null,
        background: meta.response?.background ?? null,
        elapsedSec: meta.elapsed_sec ?? null,
        promptSha256: lineage,
        statement: lineage === plan.prompt.sha256
          ? '客户端元数据里的 prompt.sha256 与本次计划一致 —— 投喂文本零改写（可机器核验）'
          : '客户端元数据里的 prompt.sha256 与计划不一致，请检查',
      }
      : null,
    stdoutTail: tail(result.stdout, 1500),
    stderrTail: tail(result.stderr, 1500),
    scheduleNote: '每张图按张计费；本项目实测 1024 方图 high 档约 100~130 秒。',
  }
}

function tail(text, max) {
  const value = normalizeText(String(text ?? ''))
  return value.length > max ? `…${value.slice(-max)}` : value
}
