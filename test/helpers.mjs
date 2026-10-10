/**
 * 测试夹具：在临时目录里搭一个最小「蓝色大肥鱼」工作区，
 * 用于验证解析、抽取与审计逻辑，不依赖真实工作区的具体内容。
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 创建一个临时工作区骨架。 */
export function makeFixtureWorkspace(options = {}) {
  const unique = `${process.pid}-${randomUUID().slice(0, 8)}`
  const root = path.join(options.baseDir ?? os.tmpdir(), `whale-fixture-${unique}`)
  const taskDirName = options.taskDirName ?? 'task07_临时测试任务'
  const taskId = 'task07'
  const textsDir = path.join(root, 'texts', taskDirName)

  for (const dir of [
    path.join(root, 'datas', '01_character'),
    path.join(root, '_tools', 'payloads', taskId),
    path.join(root, 'outs', taskDirName, 'gpt-image-2.5-sunburst'),
    textsDir,
  ]) {
    mkdirSync(dir, { recursive: true })
  }

  writeFileSync(path.join(root, '_tools', 'whale_image_client.py'), '# stub\n', 'utf8')
  writeFileSync(path.join(root, 'outs', 'INDEX.csv'), 'path,model\n', 'utf8')
  writeFileSync(path.join(root, 'texts', 'README.md'), '# texts\n', 'utf8')
  writeFileSync(path.join(root, 'datas', '01_character', '人设速查_表情包版.md'), '# 人设\n', 'utf8')

  const storyboard = [
    '# task07 · 分镜与文案锁定',
    '',
    '## 1. 逐字文案（原样复制，含加粗）',
    '',
    '```text',
    '格 1（上格）',
    '今天的鱼片格外松脆。',
    '',
    '格 2（下格）',
    '鱼片竟然会反抗。',
    '（仅「反抗」两个字加粗）',
    '```',
    '',
    '## 2. 分镜设计',
    '',
    '### 格 1（上格）· 得意',
    '',
    '- **动作**：她叉腰。',
    '',
  ].join('\n')
  writeFileSync(path.join(textsDir, '00_分镜与文案锁定.md'), storyboard, 'utf8')
  for (const fileName of ['01_提示词_GPT-Image-2.md', '02_提示词_GPT-Image-2.5.md', '03_无字底图与后期排版兜底.md', '04_验收清单.md']) {
    writeFileSync(path.join(textsDir, fileName), `# ${fileName}\n`, 'utf8')
  }

  const payloadBody = '请把这只蓝色大肥鱼画成 2~3 头身 Q 版，保留鲸鳍状耳与卷曲呆毛。\n'
  const payloadFile = path.join(root, '_tools', 'payloads', taskId, '10_母图_中性站姿.txt')
  writeFileSync(payloadFile, payloadBody, 'utf8')
  const sha = createHash('sha256').update(readFileSync(payloadFile)).digest('hex')

  // 让「负载正文仍逐字出现在它声称的来源文件里」这条校验可被验证：
  // 在 02_提示词 里放同样的正文（外面套 markdown 代码围栏，模拟真实形态）。
  writeFileSync(
    path.join(textsDir, '02_提示词_GPT-Image-2.5.md'),
    ['# 02 · GPT Image 2.5 提示词', '', '## 3. 编辑链', '', '第 0 步：', '', '```text', payloadBody.trimEnd(), '```', ''].join('\n'),
    'utf8',
  )

  writeFileSync(path.join(root, '_tools', 'payloads', taskId, '_payload_index.json'), JSON.stringify({
    generated_by: 'fixture',
    source_dir: textsDir,
    payloads: [{
      file: '10_母图_中性站姿.txt',
      chars: payloadBody.length,
      bytes: null,
      sha256: sha,
      source: '02_提示词_GPT-Image-2.5.md §3 第0步（逐字）',
    }],
  }, null, 2), 'utf8')

  return { root, taskId, taskDirName, textsDir, payloadBody }
}

/** 写一个最小合法 PNG：只有头部字节，够 readPngHeader 解析尺寸与颜色类型。 */
export function writeFakePng(absPath, { width = 1024, height = 1536, colorType = 6 } = {}) {
  const buffer = Buffer.alloc(40)
  buffer.writeUInt32BE(0x89504e47, 0)
  buffer.writeUInt32BE(0x0d0a1a0a, 4)
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  buffer[24] = 8
  buffer[25] = colorType
  writeFileSync(absPath, buffer)
  return absPath
}
