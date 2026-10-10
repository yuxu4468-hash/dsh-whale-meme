# dsh-whale-meme

> **这个仓库只有代码和文档。** 不含任何角色立绘、参考语料、出图产物或提示词成品。
> 角色与语料的授权见 [NOTICE.md](NOTICE.md)——它们仍然只归原作者与二次设计者。

## 它解决什么问题

表情包工作流的规则通常是散的：散在几个 `README.md`、几份协作说明、一份验收清单，和一堆 Python 脚本里。
新会话要全部读一遍才知道「谁写哪个目录、投喂文本不能手打、一次不能画两格」。

这些规则里有一部分**可以被机器判定**，另一部分不能。插件把前者变成工具，把后者变成技能正文：

| | 内容 | 形态 |
|---|---|---|
| 可判定 | 工作区结构、逐字文案、投喂负载是否被改写、产物血缘、产物尺寸与透明通道 | `whale_meme` 工具的 7 个 action |
| 不可判定 | 角色五要素是否保住、情绪反转是否成立、排版是否合规、合规边界 | `whale-meme-workflow` 技能正文 |

工作流里的代价是真实的：一条硬规则漏掉，就是一次付费出图调用。

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
| 计划一变令牌即失效 | 令牌把任务/步骤/模型/档位/尺寸/背景/输入图/提示词 sha256/产出文件名一起哈希 |
| 10 分钟有效 | 过期必须重新预览 |
| 每张一次调用 | 费用可控；批次由调用方一张张来 |
| 失败不自动重试 | 重试要重新确认，避免重复计费 |

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

## 使用说明

这个插件没有可点的界面——它**通过对话使用**：你用自然语言说要干什么，代理去调 `whale_meme`。
所以下面每节都是「你说什么 → 会发生什么 → 结果里看哪个字段」。

### 0. 重启后先确认它活着

在会话里说：

> 这个工作区怎么工作？

- 命中了 `whale-meme-workflow` 技能 → 技能注册成功，你会拿到四段流水线、模型差异表、编辑链与环境坑。
- 再让它调一次 `whale_meme(action="status")` → 工具注册成功。

两个都通，才算装好了。没反应就是没重启，见下面「常见问题」。

### 1. 摸清现状：`status`

> 现在这个工作区是什么状态？

返回里看这几个字段：

| 字段 | 看什么 |
|---|---|
| `root` | 插件认到的工作区根目录。**不对就是定位错了**，用 `DSH_WHALE_ROOT` 纠正 |
| `taxonomy[].exists` | 四个阶段目录（`datas`/`texts`/`_tools/payloads`/`outs`）是否都在 |
| `tasks[].missingTextsFiles` | 某个任务缺哪份提示词文件；空数组 = 五件套齐全 |
| `tasks[].payloads` | 该任务已抽取的投喂负载份数 |
| `tasks[].models[].deliverables` | 每个模型有没有推荐交付件 |
| `tasks[].warnings` | 缺 `checks.json`、缺推荐交付件之类的提醒 |

真实返回（task01）：

```json
{ "root": "F:\\whale meme",
  "tasks": [{ "id": "task01", "textsFilesPresent": 5, "textsFilesTotal": 5,
              "missingTextsFiles": [], "payloads": 7, "warnings": [] }] }
```

> 它只报告，不修。修是你的事。

### 2. 出图前必做两件事：`task` + `payload`

**先说「这个任务的台词是什么」**（`task`）——出图阶段唯一权威文本：

```json
{ "storyboard": {
    "lines": [
      { "marker": "格 1（上格）", "text": "我的字符串替换把脚本改坏了。我直接读取并修复。" },
      { "marker": "格 2（下格）", "text": "文件被我的替换操作整篇损坏。" } ],
    "boldHints": ["整篇损坏"],
    "warnings": [] } }
```

`lines[].text` **原样照抄**，一个字都不能改；`boldHints` 列出的字必须加粗，且只有这些字加粗。
`warnings` 非空（比如「没有以句末标点结尾」）说明你的 `00_*` 写得有问题，先改文案再出图。

**再说「投喂文本有没有被改过」**（`payload`）——这一步能省下一次付费出图：

```json
{ "summary": { "total": 7, "ok": 7, "drift": 0, "sourceDrift": 0, "missing": 0 },
  "entries": [{ "file": "10_母图_中性站姿.txt",
                "recordedSha256": "6a47656131dd…", "actualSha256": "6a47656131dd…",
                "source": "02_提示词_GPT-Image-2.5.md §3 第0步（逐字）",
                "matchesRecord": true, "matchesTextSource": true, "status": "ok" }] }
```

`status` 必须是 `ok`：

| 非 ok 值 | 含义 | 怎么办 |
|---|---|---|
| `payload-drift` | 磁盘上的负载与索引记录不符 → 被手打改写过 | 重跑抽取，别用它出图 |
| `source-drift` | 负载正文已不在它声称的来源文件里 → 上游 `texts/` 改了没重建 | 重建负载 |
| `missing` | 负载文件或索引没了 | 先跑 `commands(step="build")` |

### 3. 出图：先拿命令，再执行

**这个插件不会替你出图**——出图有费用、有副作用。它只给命令：

> 出图第一步该敲什么？

`whale_meme(action="commands", step="mother")` 返回可直接粘贴的 PowerShell 命令，
外加该步的注意事项（例如「第 0 步不能省：立绘是成熟比例，直接用立绘做后两格的输入会继承御姐比例」）。
`step` 可取：`build` / `mother` / `upper` / `lower` / `whole` / `compose` / `check` / `index`。

省略 `model` 时按步骤给推荐值（出图类默认 `gpt-image-2.5-sunburst`，定稿档 `xhigh`）。
要换模型或档位就明说：

> 用 gpt-image-2 出，high 档

### 4. 出完图：`lineage` + `outputs`

**`lineage` 回答「这张图到底是用哪份提示词出的」**：

```json
{ "rows": [{ "model": "gpt-image-2", "image": "02_上格_自信_1024.png",
             "promptSha256": "fb8daccebd30…", "payload": "11_上格_编辑.txt", "status": "ok" }] }
```

- `status: ok` + `payload` 有值 → 血缘清楚，可追溯到具体负载文件。
- `unknown-prompt` → 该产物用的负载**已不在索引里**（负载被重建过，或当初是手打投喂的）。这是要警惕的信号。
- `no-metadata` → 该产物没有 `.json` 元数据。**本地拼合产物（`04_拼合_*.png`）属于正常**，
  因为 `compose_panels.py` 不写元数据；其它文件出现这个就说明出图流程漏了元数据。

**`outputs` 回答「尺寸和透明通道对不对」**：

```json
{ "images": [{ "file": "05_整图一次出图_1024x1536.png", "size": "1024x1536",
               "bytesHuman": "1.87 MB", "alphaChannel": false,
               "deliverable": true, "quality": "high", "background": "opaque" }] }
```

`alphaChannel` 来自 PNG 头的**直接解析**，不是猜的：`false` 就是真的没有透明通道，要透明贴纸得走
`gpt-image-2.5-sunburst` + `background: transparent`。`deliverable: true` 标出的是推荐交付件。

> ⚠️ `outputs` 只做**机械**检查。中文逐字、加粗范围、角色五要素、情绪反差**必须人眼放大到 200% 核对**，
> 机械检查不能替代 `04_验收清单.md`。

### 5. 开新任务：`scaffold`（两步走）

> 帮我开一个新任务：题材是「改需求改到崩溃」

它**默认只出计划、不写任何文件**：

```json
{ "dryRun": true, "wrote": false,
  "plan": { "taskId": "task02", "dirName": "task02_改需求改到崩溃",
            "files": ["00_分镜与文案锁定.md", "01_提示词_GPT-Image-2.md", "02_提示词_GPT-Image-2.5.md",
                      "03_无字底图与后期排版兜底.md", "04_验收清单.md", "README.md"] } }
```

看过路径和文件名没问题，再说「确认创建」——代理会带 `write: true` 重调，才真正落盘。

如果任务号已被占用，它会**直接拒绝**（`ok: false`，错误信息里列出冲突路径），不会覆盖你已有的任务。

创建后还有三件手工活（技能正文里有详述）：**逐字文案定稿 → 抽负载 → 才算能出图**。
顺序别颠倒：先出图再改文案，已出的图就和负载对不上血缘了。

### 6. 可以直接抄的问法

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

### 7. 边界：它会做什么、不会做什么

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

## 开发

```bash
node --test --test-concurrency=1 test/core.test.mjs test/plugin-smoke.test.mjs test/integration.test.mjs
node scripts/selftest.mjs          # 对真实工作区跑全部 action 并断言结论
node scripts/selftest.mjs --json   # 机器可读报告；退出码 0 表示全部通过
```

三层测试各管一段：

| 文件 | 管什么 | 是否需要真实工作区 |
|---|---|---|
| `test/core.test.mjs` | 纯逻辑：解析、抽取、审计、命令生成、scaffold（跑在临时夹具上） | 否 |
| `test/plugin-smoke.test.mjs` | 宿主接线：工具注册、技能注册、契约注入、缺注册表时只告警不抛错（假 Cordis 上下文） | 否 |
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
  出图有费用、有副作用，所以宁可多一步确认。
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

## 目录

```
.
├── package.json                     dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml                 bundle 层默认配置
├── LICENSE                          MIT（仅覆盖本插件的代码与文档）
├── NOTICE.md                        授权边界：什么不属于本仓库、归谁
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md                      攻击面说明（能读什么、能写什么、不做什么）
├── .github/workflows/ci.yml         无依赖校验 + 四组测试 + 脚本语法检查
├── lib/
│   ├── core.mjs                     工作区定位、任务发现、文案解析、负载/血缘/产物校验
│   ├── commands.mjs                 逐字复现命令 + 模型档案 + 环境规则
│   ├── requirements.mjs             画风预设、非文本要求规范化、提示词组装、出图计划与令牌
│   ├── render.mjs                   确认令牌的发放/校验/消耗，出图执行
│   ├── payloads.mjs                 按抽取计划逐字重建投喂负载
│   ├── manifest.mjs                 .whale/manifest.json 的读写与抽取计划
│   ├── workspace.mjs                init：补齐目录与占位文件（只创建不覆盖）
│   ├── tools.mjs                    whale_meme 的 11 个 action
│   ├── scaffold.mjs                 新任务骨架
│   └── index.mjs                    DSH 接线：工具注册、技能注册、契约注入、子进程适配
├── assets/skill/whale-meme-workflow/SKILL.md
├── scripts/
│   ├── install.ps1                  装进 profile（带备份、可回滚）
│   ├── uninstall.ps1                从 profile 卸载
│   ├── patch-profile.mjs            Node 精确改写 profile 清单
│   └── selftest.mjs                 对真实工作区跑自检
└── test/                            四组测试（core / plugin-smoke / features / integration）
```

## 授权与参与

- [LICENSE](LICENSE) — MIT，只覆盖本插件的**代码与文档**
- [NOTICE.md](NOTICE.md) — 角色、语料、产物的授权**不随本插件走**，归原作者
- [CONTRIBUTING.md](CONTRIBUTING.md) — 改动约定（先写反例测试、保持只读、不引依赖）
- [SECURITY.md](SECURITY.md) — 攻击面与私密报告方式
- [CHANGELOG.md](CHANGELOG.md) — 版本变化

## 发布前检查清单

这个仓库已发布在 <https://github.com/yuxu4468-hash/dsh-whale-meme>。下面保留清单，方便**你 fork 后重新发布**：

1. ~~补仓库地址~~ **已完成**：`package.json` 的 `repository`/`bugs`/`homepage` 已指向
   `yuxu4468-hash/dsh-whale-meme`，`CHANGELOG.md` 底部链接也已换成真实账号。
   若你改了仓库名，这几处要一起改。
2. **确认 `LICENSE` 的版权行**：现在是 `Copyright (c) 2026 dsh-whale-meme contributors`，
   按你的意愿换成真名或组织名。
3. **确认授权边界**：读一遍 [NOTICE.md](NOTICE.md)。目前的口径是「本插件代码 MIT，
   角色与工作区素材不随本插件走、归原作者 上善无形 / ZipZipPipe，产出默认非商业 CC BY-NC-SA 4.0」。
   如果你希望整仓采用别的许可（例如 GPL-3.0 或与产出一致的 CC BY-NC-SA 4.0），改 `LICENSE` 与 `package.json` 的
   `license` 字段即可——但**不要把素材放进仓库**来「统一许可」。
4. **跑一遍 CI 里的每一步**（本机实测命令，Windows PowerShell）：

   ```powershell
   node -e "const p=require('./package.json');process.exit(Object.keys(p.dependencies||{}).length)"
   node --test --test-concurrency=1 test/core.test.mjs test/plugin-smoke.test.mjs
   node --test --test-concurrency=1 test/integration.test.mjs
   node --check lib/core.mjs   # 对每个 .mjs 都跑一遍
   ```

5. **确认没有个人凭据/路径被带进去**：

   ```powershell
   Select-String -Path lib/*.mjs,scripts/*.mjs,test/*.mjs,*.md -Pattern 'C:\\Users|credentials|api[_-]?key|token' 
   ```

   预期结果：除了 `scripts/patch-profile.mjs` 里解析 `--token` 参数的局部变量名，以及
   `SECURITY.md` 里对该变量的说明以外，**不应命中任何真实路径或凭据**。

6. **别把工作区一起推上去**：仓库根就是这个 `dsh-whale-meme` 目录，不是 `F:\whale meme`。
   如果你更喜欢把插件放在工作区仓库的子目录里，请先确认 `.gitignore` 挡住了 `datas/`、`texts/`、`outs/`。

## 声明

本项目与 DeepSeek 官方无关。「DeepSeek Harness」「DSH」是其各自权利人的名称，此处仅用于说明兼容性。
