# dsh-whale-meme

把**表情包绘制工作区**的工作流固化成一个可安装的 [DeepSeek Harness](https://deepseek.com)（DSH）插件：
一个 11 个 action 的校验／预览／出图工具，加一份工作流技能。

> **这个仓库只有代码和文档。** 不含任何角色立绘、参考语料、出图产物或提示词成品。
> 角色与语料的授权见 [NOTICE.md](NOTICE.md) —— 它们仍然只归原作者与二次设计者。

- **授权**：[CC0 1.0 Universal](LICENSE)（公有领域奉献）
- **依赖**：无第三方运行时依赖，只用 Node 内置模块
- **构建**：无构建步骤，`lib/*.mjs` 是原生 ESM

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [使用教程](#使用教程)
- [三步上手](#三步上手)
- [安装](#安装)
- [工具：`whale_meme`](#工具whale_meme)
- [技能：`whale-meme-workflow`](#技能whale-meme-workflow)
- [配置](#配置)
- [工作区约定](#工作区约定)
- [开发](#开发)
- [设计取舍](#设计取舍)
- [常见问题](#常见问题)
- [文件结构](#文件结构)
- [授权与参与](#授权与参与)

---

## 它解决什么问题

表情包工作流的规则通常是散的：散在几个 `README.md`、几份协作说明、一份验收清单，和一堆 Python 脚本里。
新会话要全部读一遍才知道「谁写哪个目录、投喂文本不能手打、一次不能画两格」。

这些规则里有一部分**可以被机器判定**，另一部分不能。插件把前者变成工具，把后者变成技能正文：

| | 内容 | 形态 |
|---|---|---|
| 可判定 | 工作区结构、逐字文案、投喂负载是否被改写、产物血缘、产物尺寸与透明通道 | `whale_meme` 工具的 11 个 action |
| 不可判定 | 角色五要素是否保住、情绪反转是否成立、排版是否合规、合规边界 | `whale-meme-workflow` 技能正文 |

工作流里的代价是真实的：一条硬规则漏掉，就是一次付费出图调用。

## 使用教程

这一节从头走一遍完整流程。**每个例子的输入输出都取自真实工作区**，不是示意。
约定：`你` 表示你在对话里说的话，`调用` 表示代理会去调的工具。

> 前提：已经[装好并重启](#安装后必须重启)。没重启的话，工具和技能都还没注册，下面第一步就会失败。

### 步骤 0 · 确认插件活着

```
你：这个工作区怎么工作？
调用：命中 whale-meme-workflow 技能
```
拿到的是四段流水线、两个模型的差异表、编辑链与环境坑。再让它调一次工具：

```
你：现在这个工作区是什么状态？
调用：whale_meme(action="status")
```

若这一步没有反应，回到[安装](#安装)检查是否重启。

### 步骤 1 · 摸清现状

```
你：现在是什么状态？
调用：whale_meme(action="status")
```

真实返回（task01 那个工作区）：

```jsonc
{
  "ok": true,
  "root": "F:\\whale meme",                    // 认到的根目录，不对就用 DSH_WHALE_ROOT 纠正
  "taxonomy": [                                 // 四个阶段目录是否都在
    { "stage": "research", "dir": "datas",            "exists": true },
    { "stage": "prompt",   "dir": "texts",            "exists": true },
    { "stage": "payload",  "dir": "_tools/payloads",  "exists": true },
    { "stage": "render",   "dir": "outs",             "exists": true }
  ],
  "tasks": [{
    "id": "task01",
    "textsFilesPresent": 5, "textsFilesTotal": 5,
    "missingTextsFiles": [],                    // 空数组 = 提示词五件套齐全
    "payloads": 7,                              // 已抽取的投喂负载份数
    "models": [
      { "model": "gpt-image-2",           "images": 7, "deliverables": ["05_整图一次出图_1024x1536.png"], "hasChecks": true },
      { "model": "gpt-image-2.5-sunburst","images": 7, "deliverables": ["05_整图一次出图_1024x1536.png"], "hasChecks": true }
    ],
    "warnings": []
  }]
}
```

**看哪里**：`root` 对不对；`missingTextsFiles` 是否为空；每个模型有没有 `deliverables`；`warnings` 有什么。

### 步骤 2 · 出图前：拿到权威文案

```
你：task01 的台词是什么？哪几个字要加粗？
调用：whale_meme(action="task", task="task01")
```

```jsonc
{
  "storyboard": {
    "lines": [
      { "marker": "格 1（上格）", "text": "我的字符串替换把脚本改坏了。我直接读取并修复。" },
      { "marker": "格 2（下格）", "text": "文件被我的替换操作整篇损坏。" }
    ],
    "boldHints": ["整篇损坏"],     // 只有这四个字加粗
    "warnings": []                 // 非空就是你的 00_* 格式有问题，先改文案
  }
}
```

`lines[].text` **原样照抄**，一个字都不能改。

### 步骤 3 · 出图前：确认投喂文本没被改过

这一步能省下一次付费调用。

```
你：投喂文本有没有被手打改写？
调用：whale_meme(action="payload", task="task01")
```

```jsonc
{
  "ok": true,
  "summary": { "total": 7, "ok": 7, "drift": 0, "sourceDrift": 0, "missing": 0 },
  "entries": [{
    "file": "10_母图_中性站姿.txt",
    "recordedSha256": "6a47656131dd…",
    "actualSha256":   "6a47656131dd…",   // 与索引记录一致
    "matchesTextSource": true,            // 正文仍逐字出现在来源文件里
    "status": "ok"
  }]
}
```

`status` 必须是 `ok`；不是 `ok` 就照下表处理，**别拿它出图**：

| 非 ok | 含义 | 怎么办 |
|---|---|---|
| `payload-drift` | 磁盘负载与索引记录不符（被手打改写过） | 重跑 `build`，别用它出图 |
| `source-drift` | 正文已不在来源文件里（上游 `texts/` 改了没重建） | 重跑 `build` |
| `missing` | 负载或索引没了 | 先 `{ "action": "build", "task": "…" }` |

### 步骤 4 · 开一个新任务

四步，顺序别颠倒。

```jsonc
// ① 目录缺了就补齐（只创建、不覆盖；先看计划再落盘）
{ "action": "init" }
{ "action": "init", "write": true }

// ② 建任务骨架：先 dry-run 看路径，确认后写盘
{ "action": "scaffold", "title": "改需求改到崩溃" }
{ "action": "scaffold", "title": "改需求改到崩溃", "write": true }
```

```jsonc
// scaffold 的 dry-run 返回
{ "dryRun": true, "wrote": false,
  "plan": { "taskId": "task02", "dirName": "task02_改需求改到崩溃",
            "textsDir": "…\\texts\\task02_改需求改到崩溃",
            "files": [ { "fileName": "00_分镜与文案锁定.md", "chars": 792 }, "…" ] } }
```

任务号被占用时会**直接拒绝**并列出冲突路径，不会覆盖你已有的任务。

```jsonc
// ③ 手工把 00_* 的逐字文案定稿，并在 .whale/manifest.json 补 extraction 计划
// ④ 逐字抽负载：先 dry-run 看 sha，再落盘
{ "action": "build", "task": "task02" }
{ "action": "build", "task": "task02", "write": true }
{ "action": "payload", "task": "task02" }        // 复核，应全 ok
```

### 步骤 5 · 调参数、看预览、确认出图

先说要求（这一步**不花钱**）：

```
你：换成 Q 版贴纸、1024 方形、透明底，尾鳍不要有白斑，先给我看提示词
调用：whale_meme(action="preview", task="task01", step="whole",
                 style="chibi-sticker", size="1024x1024",
                 background="transparent", extra=["尾鳍不要有白斑"])
```

返回里的 `planSummary`：

```jsonc
{ "model": "gpt-image-2.5-sunburst", "size": "1024x1024", "quality": "xhigh",
  "background": "transparent", "style": "chibi-sticker",
  "outputs": ["…\\outs\\task01_…\\gpt-image-2.5-sunburst\\06_单格_1024x1024_透明.png"] }
```

> 注意尺寸是怎么定的：`chibi-sticker` 预设带 1024²，你另给的 `size` 会覆盖它；
> `background: transparent` 让产出文件名自动带上「_透明」后缀。
> 顺带一提，`gpt-image-2` 不支持透明底，这类组合会被**直接拒绝**而不是静默降级。

`preview` 还返回 `preview` 字段（提示词全文）、`token`（确认令牌）、`styles`（可用画风清单）。
看完确认无误，再出图：

```
你：预览没问题，出图
调用：whale_meme(action="render", task="task01", step="whole",
                 style="chibi-sticker", size="1024x1024",
                 background="transparent", extra=["尾鳍不要有白斑"],
                 confirm=true, token="<preview 返回的令牌>")
```

**门禁**：不带 `confirm: true` 时只返回计划，绝不会出图；令牌一次性、10 分钟有效、
参数一改就失效。每确认一次 = 一次付费调用。

不想让插件碰出图，就用：

```jsonc
{ "action": "commands", "step": "whole", "model": "gpt-image-2.5-sunburst", "quality": "xhigh" }
```
拿到可直接粘贴的命令，自己执行。

### 步骤 6 · 出图后验收

```
你：这些产物分别是用哪份提示词出的？
调用：whale_meme(action="lineage", task="task01")
```

```jsonc
{ "rows": [{ "model": "gpt-image-2", "image": "02_上格_自信_1024.png",
             "promptSha256": "fb8daccebd30…",
             "payload": "11_上格_编辑.txt",     // 血缘清楚
             "status": "ok" }],
  "summary": { "unknownPrompt": 0, "missingMetadata": 4,
               "unaligned": ["gpt-image-2/04_拼合_1024x1536.png", "…"] } }
```

| status | 含义 |
|---|---|
| `ok` + `payload` 有值 | 可追溯到具体负载文件 |
| `unknown-prompt` | 该产物用的负载已不在索引里（负载被重建过，或当初手打投喂） |
| `no-metadata` | 没有 `.json` 元数据。**本地拼合产物（`04_拼合_*`）属正常**，其它文件出现就要查 |

```
你：出的图尺寸和透明通道对不对？
调用：whale_meme(action="outputs", task="task01")
```

```jsonc
{ "images": [{ "file": "05_整图一次出图_1024x1536.png", "size": "1024x1536",
               "bytesHuman": "1.87 MB", "alphaChannel": false,
               "deliverable": true, "quality": "high", "background": "opaque" }] }
```

`alphaChannel` 来自 PNG 头的**直接解析**：`false` 就是真没有透明通道。

> ⚠️ 这两步都是**机械**检查。中文逐字、加粗范围、角色五要素、情绪反差**必须人眼放大到 200% 核对**，
> 按 `04_验收清单.md` 走，机械检查不能替代验收。

### 步骤 7 · 出问题时的排查顺序

| 症状 | 先查这里 |
|---|---|
| 提示词五件套不齐 | `status` 的 `missingTextsFiles` |
| 文案格式不对（缺全角句号等） | `task` 的 `storyboard.warnings` |
| 担心投喂被改过 | `payload`，三种 `status` 非 ok 的含义见步骤 3 |
| 产物来路不明 | `lineage`，看 `unknown-prompt` / `no-metadata` |
| 尺寸或透明底不对 | `outputs` 的 `size` / `alphaChannel` |
| 出图失败 | `render` 返回的 `errors` / `stderrTail`；失败**不会自动重试**，要重新确认 |

## 三步上手

装好并重启之后（见[安装](#安装)），三步就能跑起来：

```jsonc
// ① 看现状：工作区在哪、缺什么、各任务什么状态
{ "action": "status" }

// ② 出图前拿到唯一权威文案与「投喂文本有没有被改过」的证据
{ "action": "task",    "task": "task01" }
{ "action": "payload", "task": "task01" }

// ③ 换画风、加要求、看最终提示词；确认后才出图
{ "action": "preview", "task": "task01", "style": "watercolor", "extra": ["尾鳍不要有白斑"] }
{ "action": "render",  "task": "task01", "style": "watercolor", "extra": ["尾鳍不要有白斑"],
  "confirm": true, "token": "<preview 返回的令牌>" }
```

不想让插件出图，就用 `{ "action": "commands", "step": "whole" }` 拿命令自己执行。

## 安装

### 方式 A：脚本（推荐，可回滚）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\install.ps1"
```

脚本按顺序做四件事，任何一步失败都自动回滚：

1. 备份 profile 的 `package.json`（`package.json.bak-whale-meme-<时间戳>`）
2. 在 `dependencies` 加一条 `"dsh-whale-meme": "link:<本目录>"`
3. 在 `dsh.profile.bundles` 末尾加一个条目
4. 在 profile 的 `node_modules` 下为本目录建 Junction（目录联接）

然后用 Node 复核清单合法性与解析链，最后提示重启。

> **为什么改 JSON 用 Node 而不是 PowerShell？** Windows PowerShell 5.1 的 `ConvertTo-Json` 会把
> 非 ASCII 字符转义成 `\uXXXX`，把本来中文可读的插件清单搞成不可读；而且历史上 DSH 的
> profile 清单曾被写入 UTF-8 BOM，导致启动时 JSON 解析失败、应用打不开。
> `scripts/patch-profile.mjs` 读写都不带 BOM，并保持原缩进与换行。

> **为什么两个 `.ps1` 带 UTF-8 BOM？** PowerShell 5.1 会把无 BOM 的 UTF-8 脚本按 GBK 读，
> 中文注释会变成语法错误。请勿用会去掉 BOM 的编辑器保存这两个文件。

### 方式 B：DSH 终端

DSH Desktop 的 `dsh` 命令**不写进系统 PATH**，用托盘菜单 **Open DSH Terminal** 打开：

```sh
dsh plugin --profile desktop add "link:<本目录绝对路径>"
```

### 安装后必须重启

DSH 插件在**应用启动时**装载。装完要**完全退出**桌面版（托盘右键 → 退出；关窗口只是隐藏），
再重新打开。用任务管理器确认没有残留的 `DeepSeek Harness` 进程。

### 卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\uninstall.ps1"
```

优先恢复安装时留下的备份；没有备份时精确摘掉两个条目。无论哪种方式都会删除
`node_modules` 下的联接（**只删联接，不删本目录**）。沙箱实测：卸载后清单与安装前逐字节相同。

## 工具：`whale_meme`

11 个 action。`status`~`commands` 只读；`scaffold` / `init` / `build` **默认 dry-run**；
`render` **默认只出计划**，真出图必须显式确认。

### 只读校验

| action | 回答什么问题 |
|---|---|
| `status` | 工作区在哪、四个阶段归属谁、每个任务缺哪份文件、负载与产物现状 |
| `task` | 这个任务的逐字文案是什么、哪几个字必须加粗、五件套齐不齐 |
| `payload` | 投喂文本有没有被手打改写（磁盘字节 sha256 + 正文是否仍逐字出现在来源文件里） |
| `lineage` | 每一张产物到底是用哪份负载出的（元数据 `prompt.sha256` ↔ 负载索引） |
| `outputs` | 产物尺寸、透明通道、推荐交付件、元数据齐全度、异常尺寸 |
| `commands` | 某一步的逐字复现命令（`build`/`mother`/`upper`/`lower`/`whole`/`compose`/`check`/`index`） |

`payload` 是其中最有价值的一个：它同时校验**磁盘字节的 sha256 与索引记录一致**，且**负载正文仍逐字出现在
它声称的来源文件里**。这是「投喂文本没有被改写」的机器证据，也是这套流水线最容易出问题的一环。

### 会写盘的动作（默认 dry-run）

| action | 做什么 | 安全设计 |
|---|---|---|
| `init` | 补齐工作区缺的目录与占位文件 | 只创建、**不覆盖**；已存在的文件一字不改；不碰 `_tools/` 脚本 |
| `scaffold` | 新建任务骨架（五件套 + README） | 拒绝覆盖已占用任务号；先出计划，`write: true` 才落盘 |
| `build` | 按清单里的抽取计划从 `texts/` 逐字重建投喂负载 | 有 `assert` 断言防索引错位；**断言失败就一个文件都不写** |

### 提示词预览与出图

| action | 做什么 |
|---|---|
| `preview` | 把「文本之外的要求」（画风/尺寸/质量档/透明底/配色/附加要求/禁止项）规范化，组装出**最终要喂的完整提示词**，给出确认令牌 |
| `render` | **确认后直接出图**：默认只返回计划；带 `confirm: true` + `preview` 发的令牌才真正调用图像模型 |

`render` 的门禁规则（每一条都有测试守着）：

| 规则 | 为什么 |
|---|---|
| 不带 `confirm: true` 绝不出图 | 出图有费用，默认什么都不做 |
| 必须有 `preview` 发的令牌 | 保证确认的是**看到的那份**计划 |
| 令牌一次性 | 用掉即失效，重复使用被拒 |
| **计划不合法不发令牌** | 令牌代表「这份计划可以出图」，发给一份出不了的计划只会误导 |
| 计划一变令牌即失效 | 令牌把任务/步骤/模型/档位/尺寸/背景/输入图/提示词 sha256/产出文件名一起哈希 |
| 10 分钟有效 | 过期必须重新预览 |
| 每张一次调用 | 费用可控；批次由调用方一张张来 |
| 失败不自动重试 | 重试要重新确认，避免重复计费 |

### 返回什么：自然语言回复

每个 action 的返回值都同时有两种读者：

- **`reply` 字段**：一段自然语言状态回复，先说结论、再给数字、最后给下一步。界面默认显示的就是它。
- **结构化字段**：`ok`、`tasks`、`entries`、`planSummary` 等照旧全在，供代理与脚本判断。

例如 `status` 的 `reply`：

```
✅ 工作区在 F:\whale meme

四个阶段目录：datas✓  texts✓  _tools/payloads✓  outs✓

共 1 个任务：
  · task01 · 字符串替换把脚本改坏了
      提示词 5/5，投喂负载 7 份
      gpt-image-2：7 张图，交付件 05_整图一次出图_1024x1536.png
      gpt-image-2.5-sunburst：7 张图，交付件 05_整图一次出图_1024x1536.png

下一步：看某个任务的逐字文案用 task（例如 task="task01"）；确认投喂文本没被改过用 payload。
```

回复层的两条硬规则，都有测试守着：

1. **失败就是失败**：不会把失败说成「完成」，也不会在失败时给出「可以出图」的指引；
2. **回复层是附加物**：它自己出错时不影响结构化结果，只会在回复里说明「生成回复时出错」。

出图执行走工作区既有的 `_tools/whale_image_client.py`（不重复实现 HTTP），
并在提示词落盘后**再核一次 sha256**；返回里会指明客户端元数据里的 `prompt.sha256`
是否与本次计划一致 —— 这是投喂零改写的机器证据。

### 文本之外的要求

```jsonc
{ "action": "preview", "task": "task02",
  "style": "chibi-sticker",                     // 画风预设
  "size": "1024x1024", "quality": "xhigh",
  "background": "transparent",                  // 只对 gpt-image-2.5 系有效
  "palette": ["深藏青为主"],
  "extra": ["尾鳍不要有白斑", "气泡距顶端至少 5% 高度"],
  "avoid": ["第二个人物"],
  "panels": 1 }
```

画风预设：`anime-cel`（日系 Q 版赛璐璐，默认）/ `chibi-sticker` / `watercolor` / `flat-vector` /
`pixel-art` / `retro-anime-90s`，也可传自定义风格描述。

三条设计约束：

1. **不重写基础提示词** —— 要求以追加段落加在原文之后，原文逐字保留，预览里一眼能看出加了什么；
2. **禁止项改写成正向句子** —— 两个图像模型都没有负向词参数；
3. **凭据与「官方」措辞被直接拒绝** —— 前者不该进提示词，后者违反合规底线。

### 可以直接抄的问法

```
这个工作区怎么工作？
现在是什么状态？
工作区还缺哪些目录？（init）
task01 的台词是什么？哪几个字要加粗？
投喂文本有没有被手打改写？
负载要重建一下（build）
换成水彩画风、1024 方形、透明底，先给我看提示词预览（preview）
预览没问题，出图（render + confirm + token）
这些产物分别是用哪份提示词出的？
出的图尺寸和透明通道对不对？
帮我开一个新任务：题材是「……」
```

### 边界：它会做什么、不会做什么

| | 说明 |
|---|---|
| **能出图，但默认不出** | `render` 不带 `confirm: true` 时只返回计划；确认要带 `preview` 发的令牌，一次性、计划一改即失效 |
| **能写盘，但默认不写** | `scaffold` / `init` / `build` 都要显式 `write: true`；`init` 只创建不覆盖 |
| 不替你写文案 | `task` 只读 `00_*` 并结构化，绝不改写 |
| 不自动验收 | `outputs` 是机械检查，**不能替代** `04_验收清单.md` 的人眼逐字核对 |
| 失败不自动重试出图 | 重试要重新确认，避免重复计费 |
| 不发布、不上传 | 出图是调用图像 API；插件自身没有别的网络代码，也没有遥测 |
| 不碰工作区外的文件 | 唯一例外是安装/卸载脚本改 DSH profile（带备份、可回滚） |
| 不碰 `_tools/` 下的脚本 | 只读引用；出图也是调用那份既有客户端，不重写它 |

> 出图的费用与副作用由**调用方**承担：每确认一次 = 一次付费调用。插件把「确认」做成了一次性的令牌，
> 而不是一个可以复用的开关。

## 技能：`whale-meme-workflow`

正文在 [`assets/skill/whale-meme-workflow/SKILL.md`](assets/skill/whale-meme-workflow/SKILL.md)，包含：

- 四段流水线与各阶段唯一写入者
- 两个图像模型的差异表（透明底、质量档、编辑保持能力）
- 「立绘 → Q 版母图 → 上格 → 下格」编辑链，以及为什么第 0 步不能省
- 7 条本机实测环境坑（签名 URL 过期、下载需浏览器 UA、pwsh 不能内联中文等）
- 验收五组与合规底线
- 新任务开局：`init` 补目录 → `scaffold` 建骨架 → 文案定稿 → `build` 抽负载
- `extraction` 抽取计划的写法与 `assert` 断言防错位的原因
- `preview` 的非文本要求清单与三条设计约束
- `render` 的门禁规则表

## 配置

`cordis.patch.yml`，或 profile 的 `cordis.patch.yml` 里 `id: whale-meme` 条目可覆盖：

| 键 | 默认 | 含义 |
|---|---|---|
| `root` | `null` | 显式工作区根目录；留空则按 `DSH_WHALE_ROOT` → 从会话工作目录逐级向上探测 |
| `injectWorkspaceContract` | `true` | 是否把工作流契约注入工作区上下文 |
| `registerSkill` | `true` | 是否注册技能 |
| `contractMaxChars` | `6000` | 契约注入的字符上限 |

环境变量：

| 变量 | 用途 |
|---|---|
| `DSH_WHALE_ROOT` | 直接指定工作区根目录，跳过自动探测 |
| `DSH_WHALE_PYTHON` | 指定 Python 解释器；不设则用 DSH 自带运行时，再退回 PATH 里的 `python` |

## 工作区约定

插件不改变你的目录结构，只是**读取并校验**它。它期望的工作区形态：

```
<工作区根>/
├── .whale/manifest.json        工作区清单：目录树 + 各任务的负载抽取计划
├── datas/                      角色与参考资料（只读基准）
│   └── 01_character/           人设速查 + 原始立绘
├── texts/                      成品提示词（一个任务一个 taskNN_* 目录）
│   └── taskNN_<标题>/
│       ├── 00_分镜与文案锁定.md      唯一权威文本源
│       ├── 01_提示词_GPT-Image-2.md
│       ├── 02_提示词_GPT-Image-2.5.md
│       ├── 03_无字底图与后期排版兜底.md
│       └── 04_验收清单.md
├── _tools/                     出图客户端与校验脚本
│   └── payloads/<task>/        由脚本从 texts/ 逐字抽取的投喂负载
└── outs/                       出图产物（一个模型一个子目录）
    └── <task>/<model>/
```

工作区根目录的识别判据（`lib/core.mjs` 的 `looksLikeWhaleWorkspace`）：下列特征命中 **≥2 条**即认定为工作区——
`_tools/whale_image_client.py`、`_tools/payloads/`、`datas/01_character/`、`texts/README.md`、`outs/INDEX.csv`。
判据刻意宽松但不至于误判普通目录；不匹配时用 `DSH_WHALE_ROOT` 显式指定。

目录缺失时用 `{ "action": "init" }` 补齐（先看计划，再 `write: true`）。

### 投喂负载的抽取计划

`.whale/manifest.json` 里为每个任务记录一段 `extraction` 计划，
让 `build` 能**不依赖工作区那份写死任务路径的 `build_payloads.py`** 重建负载：

```jsonc
{
  "id": "task01",
  "dirName": "task01_字符串替换把脚本改坏了",
  "extraction": {
    "payloads": [
      { "file": "10_母图_中性站姿.txt", "from": "02_提示词_GPT-Image-2.5.md", "block": 2,
        "source": "02_…§3 第0步（逐字）", "assert": "中性站姿全身母图" }
    ]
  }
}
```

- `block` 是 markdown 代码围栏的**序号（从 0 开始）**；
- `assert` 是**防错位的断言短语**，那一块里必须出现它，否则拒绝抽取。**别省这个字段**
  —— 索引错位抽错内容，代价是一次付费出图；
- 抽取口径与既有脚本一致（只做换行归一化、结尾一个换行、sha256 对磁盘字节取）。
  已用 task01 的 7 份负载逐一比对验证过：**sha256 全部相同**。

## 开发

```bash
node --test --test-concurrency=1 test/core.test.mjs test/plugin-smoke.test.mjs \
  test/features.test.mjs test/reply.test.mjs test/integration.test.mjs
node scripts/selftest.mjs          # 对真实工作区跑全部 action 并断言结论
node scripts/selftest.mjs --json   # 机器可读报告；退出码 0 表示全部通过
```

五组测试各管一段：

| 文件 | 管什么 | 是否需要真实工作区 |
|---|---|---|
| `test/core.test.mjs` | 纯逻辑：解析、抽取、审计、命令生成、scaffold（跑在临时夹具上） | 否 |
| `test/plugin-smoke.test.mjs` | 宿主接线：工具注册、技能注册、契约注入、缺注册表时只告警不抛错（假 Cordis 上下文） | 否 |
| `test/features.test.mjs` | 非文本要求、提示词组装、出图计划与令牌门禁、init、负载重建 | 否 |
| `test/reply.test.mjs` | 自然语言回复：覆盖全部 action、失败不说成完成、不该给令牌时不给、回复层出错不影响结构 | 否 |
| `test/integration.test.mjs` | 真实工作区上的结论是否正确 | 是，不在时自动跳过 |

**没有构建步骤**：`lib/*.mjs` 是原生 ESM，DSH 直接加载。代价是没有静态类型，收益是不存在
「源码与产物不一致」这一类问题。修改源码立即生效（Junction 装法），不需要重新安装。

## 设计取舍

- **分层**：`lib/core.mjs`（纯逻辑，只依赖 `node:`）→ `lib/requirements.mjs` / `lib/payloads.mjs` /
  `lib/workspace.mjs`（计划与抽取，仍然是纯逻辑）→ `lib/tools.mjs`（action 分发）→
  `lib/index.mjs`（唯一的 DSH 接线层）。前三层脱离宿主就能测，测试里也确实这么测的。
- **定位失败不阻塞装载**：找不到工作区时插件照常装载，工具在每次调用时重新解析并给出可执行错误。
- **`subprocess` 不列为必需**：它是 `render` 才需要的可选能力。列为必需会让插件在缺少该服务的宿主上
  整个保持 pending —— 连只读工具都装不上，这比「出图不可用」糟糕得多。
- **契约注入是加分项**：宿主没有可用入口时只写一条 debug 日志；契约内容同时内嵌在技能正文里，不会丢。
- **出图默认什么都不做**：`render` 不带 `confirm` 时绝不触发子进程；令牌一次性、计划一变即失效。
- **写盘动作一律默认 dry-run**：`scaffold` / `init` / `build` 都要显式 `write: true`。
- **不重复实现 HTTP**：出图走工作区既有的 `_tools/whale_image_client.py`，
  重试、签名 URL 过期、浏览器 UA 这些坑留在那一处。
- **不重写基础提示词**：非文本要求以追加段落形式拼接，原文逐字保留，预览可核对。

## 常见问题

| 现象 | 处理 |
|---|---|
| 装完看不到 `whale_meme` | 没重启。完全退出托盘再打开 |
| 报「没有找到蓝色大肥鱼工作区」 | 设 `DSH_WHALE_ROOT` 指向工作区根目录 |
| 报「profile 没有 node_modules」 | 先用 DSH 终端装过任意一个插件，即可生成该目录 |
| `payload` 报 `payload-drift` | 负载被手打改写过，或上游 `texts/` 改了而负载没重建。重建后再出图 |
| `lineage` 报 `unknown-prompt` | 该产物用的负载已不在索引里（负载被重建或曾手打投喂） |
| `lineage` 报 `no-metadata` | 该产物没有元数据。本地拼合产物属正常；其它情况请检查 |
| `build` 说「清单里没有 extraction 计划」 | 按返回里的模板在 `.whale/manifest.json` 给该任务补一段；**别省 `assert`** |
| `build` 说「断言短语找不到」 | 索引错位了。核对 `block` 序号，不要绕过断言 |
| `render` 说「缺少 token」 | 先 `preview` 拿令牌；令牌一次性，用掉要重新 preview |
| `render` 说「令牌与当前计划不一致」 | 预览之后改了参数。重新 preview 再确认 |
| `render` 说宿主没有子进程能力 | 用 `commands` 拿命令自己执行（插件明确拒绝，不会静默失败） |
| `preview` 说「拿不到基础提示词」 | 该任务缺 `02_提示词_*.md`，或用 `rawPrompt` 直接给提示词正文 |

## 文件结构

```
.
├── package.json                     dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml                 bundle 层默认配置
├── LICENSE                          CC0 1.0 Universal（公有领域奉献）
├── NOTICE.md                        授权边界：什么不属于本仓库、归谁
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md                      攻击面说明（能读什么、能写什么、不做什么）
├── .github/workflows/ci.yml         无依赖校验 + 五组测试 + 脚本语法检查
├── lib/
│   ├── core.mjs                     工作区定位、任务发现、文案解析、负载/血缘/产物校验
│   ├── commands.mjs                 逐字复现命令 + 模型档案 + 环境规则
│   ├── requirements.mjs             画风预设、非文本要求规范化、提示词组装、出图计划与令牌
│   ├── render.mjs                   确认令牌的发放/校验/消耗，出图执行
│   ├── payloads.mjs                 按抽取计划逐字重建投喂负载
│   ├── manifest.mjs                 .whale/manifest.json 的读写与抽取计划
│   ├── workspace.mjs                init：补齐目录与占位文件（只创建不覆盖）
│   ├── reply.mjs                    每个 action 的自然语言状态回复（先结论、再数字、给下一步）
│   ├── tools.mjs                    whale_meme 的 11 个 action
│   ├── scaffold.mjs                 新任务骨架
│   └── index.mjs                    DSH 接线：工具注册、技能注册、契约注入、子进程适配
├── assets/skill/whale-meme-workflow/SKILL.md
├── scripts/
│   ├── install.ps1                  装进 profile（带备份、可回滚）
│   ├── uninstall.ps1                从 profile 卸载
│   ├── patch-profile.mjs            Node 精确改写 profile 清单
│   └── selftest.mjs                 对真实工作区跑自检
└── test/                            五组测试（core / plugin-smoke / features / reply / integration）
```

## 授权与参与

- [LICENSE](LICENSE) — **CC0 1.0 Universal**：本仓库的原创代码与文档已贡献到公有领域，
  可自由使用、修改、再分发，**无需署名**。该文件是 CC0 官方原文、一字未改
  （GitHub 的许可识别采用精确匹配，改动文本会让仓库页显示成「Other」）；
  本仓库的适用范围与例外写在 [NOTICE.md](NOTICE.md) 第七节
- [NOTICE.md](NOTICE.md) — 授权边界：什么不属于本仓库、归谁；以及 CC0 的适用范围
  （不含商标权与专利权，见 CC0 第 4(a) 条）
- [CONTRIBUTING.md](CONTRIBUTING.md) — 改动约定（先写反例测试、保持只读、不引依赖）
- [SECURITY.md](SECURITY.md) — 攻击面与私密报告方式
- [CHANGELOG.md](CHANGELOG.md) — 版本变化

本项目与 DeepSeek 官方无关。「DeepSeek Harness」「DSH」是其各自权利人的名称，此处仅用于说明兼容性。
