---
name: whale-meme-workflow
description: 「蓝色大肥鱼」表情包（F:\whale meme 工作区）的固定绘制工作流。当任务涉及这个工作区的表情包出图、写生图提示词、投喂 GPT Image 2 / 2.5、编辑链出图、拼合两格、产物验收，或问「这个工作区怎么工作 / 下一步做什么」时使用。
---

# 「蓝色大肥鱼」表情包工作流

本工作区把**一张表情包**从题材走到成品，固定为四段流水线。每段只有一个写入者，产物落在固定目录，**阶段之间靠文件交接，不靠口头传递**。

```
datas/  ① 资料基准 ──► texts/  ② 提示词 ──► _tools/payloads/  ③ 逐字抽取 ──► outs/  ④ 出图产物
（只读）                （唯一可写）        （脚本生成，禁止手打）      （模型目录 + 元数据）
```

**先做这一件事**：调用一次 `whale_meme(action="status")`。它是只读的，会告诉你工作区根目录、阶段归属、每个任务缺哪份文件、负载与产物现状。不要靠猜。

> **返回值怎么读**：每次调用都会带一个 `reply` 字段 —— 一段自然语言状态回复，先结论、再数字、最后给下一步。
> **直接把它转述给用户即可**，不要自己重排成 JSON 或表格。要判断与续跑时再读结构化字段
> （`ok` / `tasks` / `entries` / `planSummary` 等，一个都没删）。
> 注意两条：计划不合法时 `preview` 不会给确认令牌，**不要拿 `null` 令牌去调 render**；
> 失败时 `reply` 会说明原因与下一步，照它说的做，不要自动重试出图。

---

## 0. 三条不可违反的规则

1. **文案唯一权威**：`texts/<task>/00_分镜与文案锁定.md` 的「逐字文案」小节。出图阶段**不得**改写、不得加说话人姓名、标题、英文、数字、水印。用 `whale_meme(action="task")` 拿到逐字行与必须加粗的字。
2. **投喂文本不得手打**：一律由 `_tools/build_payloads.py` 从 `texts/` 逐字抽取到 `_tools/payloads/<task>/`，出图用 `--prompt-file`。**禁止** `--prompt-text`，**禁止**在 pwsh 命令里内联中文（PowerShell 会破坏中文编码）。
3. **一次只改一个变量**：不要一次画两格。先用编辑链把角色锁成 Q 版母图，再由母图逐格编辑；角色漂移几乎都来自「一次出两格」。

---

## 1. 阶段① 资料基准（`datas/`，只读）

- `datas/01_character/人设速查_表情包版.md` + `datas/01_character/原始立绘_deepseek_whale.png` 是**唯一角色基准**。
- 角色剪影三要素，任何提示词与产物都不得丢失：**头侧两片鲸鳍状耳**、**身后完整大体量双叉鲸尾**、**深蓝→浅蓝渐变长发＋头顶偏左卷曲呆毛**。丢了任何一项即视为角色不成立、必须重出。
- `datas/02_reference_stickers/` 的 251 张社区同人语料**只作风格／题材／构图参考，不得当成品交付**。
- `datas/02_reference_stickers/_annotations/corpus_overview.md` 的形式结论：叙事最多做**上下两格**，不要做 3×3 多格。

## 2. 阶段② 提示词（`texts/`，本阶段唯一可写）

一个任务一个目录，五个固定文件位，缺一不可：

| 文件 | 作用 |
|---|---|
| `00_分镜与文案锁定.md` | ★ 唯一权威文本源：逐字文案 + 加粗位置 + 画面设计 |
| `01_提示词_GPT-Image-2.md` | 投喂 GPT Image 2（含参数、分步工作流、翻车修正） |
| `02_提示词_GPT-Image-2.5.md` | 投喂 GPT Image 2.5（Flare/Sunburst 分工、母图编辑流、透明底） |
| `03_无字底图与后期排版兜底.md` | 中文写错／加粗失效时改走这条，含即用 HTML 排版模板 |
| `04_验收清单.md` | 出图后逐项打勾；A/B 组 FAIL 必须重出 |

新建任务**只新建 `taskNN_*` 目录**，不改动已有任务的任何文件；并在 `texts/README.md` 的任务索引追加一行。

**两个模型的关键差异决定工作流**：

| | GPT Image 2 | GPT Image 2.5 |
|---|---|---|
| 透明底 | **不支持**（响应固定 opaque）→ 浅灰白平涂底出图，后期抠图补白描边 | **支持** `background: transparent`，实测出真 RGBA |
| 质量档 | low / medium / high | low / medium / high / **xhigh** / **max** |
| 本任务用法 | 可控的分格编辑 | **首选**：多轮编辑不跑偏，定稿 Sunburst + xhigh |
| 负向词 | 无该参数 → 一律把「要避免什么」写成**正向自然语言句子** | 同左 |

## 3. 阶段③ 逐字抽取（`_tools/payloads/<task>/`，脚本生成）

```powershell
& <python> '_tools/build_payloads.py'
```

抽完**必须核验**：`whale_meme(action="payload")` 要求每条 `status` 都是 `ok` —— 它同时校验两件事：磁盘字节的 sha256 与索引记录一致，且负载正文仍**逐字出现在它声称的 texts/ 来源文件里**。任何 drift 都说明负载被手打改写过或被上游改坏了，必须重建后再出图。

> `build_payloads.py` 里的任务路径目前是 task01 的字面量；换任务要先改脚本顶部的 `TASK` / `OUT` 常量。

## 4. 阶段④ 出图（`outs/<task>/<model>/`）

**编辑链（推荐，角色最稳）**

```
原始立绘（成熟比例）
  │ ① mother  母图：锁身份 + 压成 2~3 头身 Q 版   ← 这一步不能省
  ▼ 01_母图_中性站姿_1024.png
  │ ② upper   只改场景/表情/屏幕/气泡
  ▼ 02_上格_自信_1024.png
  │ ③ lower   单变量编辑（只改表情/姿态/屏幕/符号）
  ▼ 03_下格_破防_1024.png
  │ ④ compose 本地拼合 --focus top（无 API 费用）
  ▼ 04_拼合_1024x1536.png / 04_拼合_1024x2072.png
```

**方案 A（备选）**：`whole` 直接一次出 `1024×1536` 整图 → `05_整图一次出图_1024x1536.png`（★推荐交付件）。

每一步的逐字命令用 `whale_meme(action="commands", step="mother|upper|lower|whole|compose|check|index")` 取，不要手写命令。

**先读 `outs/README.md` 再动手**：里面记着两个模型在本网关的实测差异、以及三个已踩过的坑。`outs/<task>/_验收记录.md` 是逐项验收与缺陷修复记录，**改任何出图流程前先读它**。

## 5. 环境坑（全部是本机实测，违反会浪费一次付费调用）

1. **图像模型不能当子代理的 LLM**：`/chat/completions` 会被网关拒绝（「该模型是图像生成模型」），DSH 子代理只能以文本模型运行、由脚本调用图像模型。
2. 返回的是**约 30 分钟过期的签名 URL**，必须立即下载。
3. 下载**必须带浏览器 User-Agent**，否则 Cloudflare `403 error code: 1010`。
4. JSON 端点的 `n` **必须是整数**。
5. pwsh 里**不要内联中文**，一切文本走 `--prompt-file`。
6. `edit` 端点用 `--image` 传参考图；立绘是成熟比例，编辑链第 0 步必须先压成 Q 版母图。
7. 每次调用给 `--timeout 900`：high 档约 100~130 s/张，xhigh 更久。

## 6. 验收（`04_验收清单.md`，五组）

| 组 | 内容 | FAIL 的后果 |
|---|---|---|
| A | 文案与排版：逐字、全角句号、**加粗范围**、无多余文字 | 必须重出，或改走 `03_无字底图与后期排版兜底.md` |
| B | 角色一致性：鲸鳍耳／鲸尾／渐变发色／服装／Q 版比例／两格不变量 | 视为角色不成立，必须重出 |
| C | 分镜与情绪：两格反差一眼可辨、屏幕内容为抽象乱码 | 回提示词修正后重跑 |
| D | 技术与输出：尺寸、格间 24 px、外框、透明通道、240×240 可读性 | 同上 |
| E | 交付与合规：非官方同人、署名、许可、参考语料未当成品 | 同上 |

`whale_meme(action="outputs")` 只做**机械**检查（尺寸、透明通道、元数据、推荐交付件齐全）；**逐字中文、加粗范围、角色五要素、情绪反差必须人眼放大到 200% 核对**，机械检查不能替代验收清单。

**合规底线**：非官方同人表情包；署名入口角色原作 **上善无形**、女仆鲸鱼娘二次设计 **ZipZipPipe**；**非商业 CC BY-NC-SA 4.0**；不得出现「官方／官方授权」措辞；不得用于售卖、联名、募资。

## 7. 常见「下一步」对照

| 你想做的事 | 用哪个 |
|---|---|
| 不知道现在能做啥 | `whale_meme(action="status")` |
| 工作区还缺哪些目录/文件 | `whale_meme(action="init")`（dry-run）→ 确认后 `write=true` |
| 这个任务的台词是什么、哪几个字加粗 | `whale_meme(action="task", task="task01")` |
| 投喂文本有没有被改过 | `whale_meme(action="payload", task="task01")` |
| 负载要重建 | `whale_meme(action="build", task="task01")`（dry-run）→ `write=true` |
| 换画风/尺寸/质量档/透明底/附加要求 | `whale_meme(action="preview", …, style="chibi-sticker", extra=["…"])` |
| 看这次到底要喂什么提示词 | 同上，返回里的 `preview` 字段就是完整提示词正文 |
| 确认后直接出图 | `whale_meme(action="render", confirm=true, token="…")` |
| 产物到底是用哪份提示词出的 | `whale_meme(action="lineage", task="task01")` |
| 出的图尺寸/透明通道对不对 | `whale_meme(action="outputs", task="task01")` |
| 下一步该敲哪条命令（不想让插件出图） | `whale_meme(action="commands", step="upper")` |
| 开一个新任务（骨架） | `whale_meme(action="scaffold", title="题材")` — 默认只出计划，加 `write=true` 才落盘 |

---

## 8. 新任务的开局（`scaffold` + `init`）

```jsonc
// 工作区缺目录时先补齐（只创建、不覆盖，默认 dry-run）
{ "action": "init" }                 // 看将创建什么
{ "action": "init", "write": true }  // 真正创建

// 第一步：只看计划，不写任何文件
{ "action": "scaffold", "title": "程序员自嘲梗" }

// 确认路径与文件名无误后，才真正创建
{ "action": "scaffold", "title": "程序员自嘲梗", "write": true }
```

`init` 补齐 `datas/01_character`、`datas/02_reference_stickers`、`texts`、`outs`、`_tools/payloads`、`.whale`
与工作区 README、`outs/INDEX.csv` 占位；**已存在的文件一字不改**，`_tools/` 下的脚本一律不碰。

`scaffold` 按现有最大任务号 +1 建 `texts/taskNN_<标题>/`，一次写齐六个文件（五件套 + 本目录 README），
并且**拒绝覆盖已占用的任务号**。

创建后必须手工完成的三件事：

1. 把 `00_分镜与文案锁定.md` 的**逐字文案定稿**：标记行只用于分组，整行括号只写加粗要求，句末用全角句号。
   （`whale_meme(action="task")` 会用同一套解析器复核你的格式，句末缺标点会直接点名。）
2. 在 `.whale/manifest.json` 里给这个任务补一段 `extraction` 计划（见下节），然后 `build`。
3. 在 `texts/README.md` 的任务索引追加一行。

> 顺序不要颠倒：**文案定稿 → 抽负载 → 出图**。先出图再改文案，已经出的图就和负载对不上血缘了。

---

## 9. 投喂负载：`build` 与 `extraction` 计划

`_tools/build_payloads.py` 的任务路径是**写死的字面量**，换任务就得改脚本 —— 而脚本是工作区自己的资产，
插件不该改。所以负载重建走 `.whale/manifest.json` 里的**抽取计划**：

```jsonc
{
  "id": "task02",
  "dirName": "task02_程序员自嘲梗",
  "extraction": {
    "payloads": [
      { "file": "10_母图_中性站姿.txt", "from": "02_提示词_GPT-Image-2.5.md", "block": 2,
        "source": "02_…§3 第0步（逐字）", "assert": "中性站姿全身母图" }
    ]
  }
}
```

- `block` 是 markdown 代码围栏的**序号（从 0 开始）**；`build_payloads.py` 的既有映射是
  `0=参数 / 1=整图主提示词 / 2=母图 / 3=上格 / 4=下格`。
- `assert` 是**防错位的断言短语**：那一块里必须出现它，否则拒绝抽取。**别省这个字段**
  —— 索引错位抽错内容，代价是一次付费出图。
- 抽取口径与既有脚本一致：只做换行归一化，结尾保证一个换行，sha256 对磁盘字节取。
  **可机器验证**：拿既有 task01 的索引比对，7 份负载 sha256 逐一相同。

```jsonc
{ "action": "build", "task": "task02" }                 // dry-run：只算 sha，不落盘
{ "action": "build", "task": "task02", "write": true }  // 落盘并重建 _payload_index.json
```

---

## 10. 文本之外的要求与提示词预览（`preview`）

工作流原本只有文案可调。`preview` 让你在出图前把**非文本要求**规范化，并看到**最终要喂的完整提示词**。

```jsonc
{
  "action": "preview",
  "task": "task02",
  "step": "whole",              // whole / mother / upper / lower
  "style": "chibi-sticker",     // 画风预设，见下
  "size": "1024x1024",
  "quality": "xhigh",
  "background": "transparent",  // 只对 gpt-image-2.5 系有效
  "palette": ["深藏青为主", "避开发灰的蓝"],
  "extra": ["尾鳍不要有白斑", "气泡距顶端至少 5% 高度"],
  "avoid": ["第二个人物", "真人照片元素"],
  "panels": 1,
  "label": "贴纸版"
}
```

**画风预设**：`anime-cel`（日系 Q 版赛璐璐，工作区默认）/ `chibi-sticker`（Q 版贴纸单格，强制 1024²）/
`watercolor` / `flat-vector` / `pixel-art` / `retro-anime-90s`。也可以直接传自定义画风描述文本。
不在预设表里但像风格描述的，会降级成自定义并给出提示；完全不像的会被拒绝。

**三条设计约束**（预览里能直接看出来）：

1. **不重写基础提示词**。画风与要求一律以「追加段落」加在原文之后，原文逐字保留 —— 
   这样你能一眼看出加了什么，而不是原文被搅碎。
2. **禁止项改写成正向句子**。两个图像模型都**没有负向词参数**，所以「不要第二个人物」
   会被写成「画面中不要出现第二个人物；如果可能，请改为更合适的画法」。
3. **凭据与「官方」措辞会被直接拒绝**：前者不该进提示词，后者违反验收清单 E 组的合规底线。

预览返回 `planSummary`（结构化参数）、`preview`（人读全文，含提示词正文与 sha256）、
`token`（确认令牌）与 `styles`（可用画风清单）。

---

## 11. 确认后直接出图（`render`）

出图**有费用、有副作用**，所以这一层的设计原则是「默认什么都不做」：

```jsonc
// 1) 先预览，拿到 token
{ "action": "preview", "task": "task02", "style": "anime-cel", "extra": ["尾鳍不要有白斑"] }

// 2) 看完预览确认无误，带 confirm + token 再调
{ "action": "render", "task": "task02", "style": "anime-cel", "extra": ["尾鳍不要有白斑"],
  "confirm": true, "token": "<preview 返回的令牌>" }
```

门禁规则（每一条都有测试守着）：

| 规则 | 说明 |
|---|---|
| 默认不出图 | 不带 `confirm: true` 时只返回计划，**绝不触发子进程** |
| 必须有令牌 | 令牌由 `preview` 发出；`render` 内部**不重新发令牌**（否则会把用掉的令牌复活） |
| 令牌一次性 | 用掉即失效，重复使用会被拒 |
| 计划一变就失效 | 令牌把「任务/步骤/模型/档位/尺寸/背景/输入图/提示词 sha256/产出文件名」一起哈希，任一变化都对不上 |
| 10 分钟有效 | 过期必须重新预览 |
| 每张一次调用 | 不支持批量；批次由调用方一张张来，费用可控 |
| 失败不自动重试 | 重试要重新确认，避免重复计费 |

执行时：把提示词写到 `outs/<task>/<model>/_prompt/<产出名>__<sha8>.txt`，**落盘后再核一次 sha256**，
然后调用工作区既有的 `_tools/whale_image_client.py`（gen / edit）。HTTP 重试、签名 URL 立即下载、
浏览器 UA 这些坑全部交给那份脚本，插件不重复实现。

出图后返回 `output`（路径/字节）、`meta`（模型/尺寸/档位/透明底，以及
**元数据里的 `prompt.sha256` 是否与本次计划一致** —— 投喂零改写的机器证据）、
以及 `stdoutTail` / `stderrTail`。

> 宿主没有子进程能力时，`render` 会明确拒绝并让你改用 `commands` 拿命令自己执行 —— 不会静默失败。


