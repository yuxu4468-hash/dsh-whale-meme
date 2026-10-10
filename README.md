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

除 `scaffold` 的落盘分支外，全部只读：不生成图片、不改任何既有文件。

| action | 回答什么问题 |
|---|---|
| `status` | 工作区在哪、四个阶段归属谁、每个任务缺哪份文件、负载与产物现状 |
| `task` | 这个任务的逐字文案是什么、哪几个字必须加粗、五件套齐不齐 |
| `payload` | 投喂文本有没有被手打改写（磁盘字节 sha256 + 正文是否仍逐字出现在来源文件里） |
| `lineage` | 每一张产物到底是用哪份负载出的（元数据 `prompt.sha256` ↔ 负载索引） |
| `outputs` | 产物尺寸、透明通道、推荐交付件、元数据齐全度、异常尺寸 |
| `commands` | 某一步的逐字复现命令（`build`/`mother`/`upper`/`lower`/`whole`/`compose`/`check`/`index`） |
| `scaffold` | 新建任务骨架：默认 **dry-run** 只出计划，`write: true` 才创建；拒绝覆盖已占用任务号 |

`payload` 是其中最有价值的一个：它同时校验**磁盘字节的 sha256 与索引记录一致**，且**负载正文仍逐字出现在
它声称的来源文件里**。这是「投喂文本没有被改写」的机器证据，也是这套流水线最容易出问题的一环。

## 技能：`whale-meme-workflow`

正文在 [`assets/skill/whale-meme-workflow/SKILL.md`](assets/skill/whale-meme-workflow/SKILL.md)，包含：

- 四段流水线与各阶段唯一写入者
- 两个图像模型的差异表（透明底、质量档、编辑保持能力）
- 「立绘 → Q 版母图 → 上格 → 下格」编辑链，以及为什么第 0 步不能省
- 7 条本机实测环境坑（签名 URL 过期、下载需浏览器 UA、pwsh 不能内联中文等）
- 验收五组与合规底线
- 新建任务的开局顺序

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

- **分层**：`lib/core.mjs`（纯逻辑，只依赖 `node:`）→ `lib/commands.mjs`（命令生成）→
  `lib/tools.mjs`（action 分发）→ `lib/index.mjs`（唯一的 DSH 接线层）。前三层脱离宿主就能测。
- **定位失败不阻塞装载**：找不到工作区时插件照常装载，工具在每次调用时重新解析并给出可执行错误，
  这样插件不会「换个目录就整个失效」。
- **契约注入是加分项**：宿主没有可用入口时只写一条 debug 日志；契约内容同时内嵌在技能正文里，不会丢。
- **出图不自动化**：出图有费用、有副作用。`commands` 只生成逐字命令，由人/代理显式发起。
- **scaffold 默认 dry-run**：写盘必须显式 `write: true`。

## 常见问题

| 现象 | 处理 |
|---|---|
| 装完看不到 `whale_meme` | 没重启。完全退出托盘再打开 |
| 报「没有找到蓝色大肥鱼工作区」 | 设 `DSH_WHALE_ROOT` 指向工作区根目录 |
| 报「profile 没有 node_modules」 | 先用 DSH 终端装过任意一个插件，即可生成该目录 |
| `payload` 报 `payload-drift` | 负载被手打改写过，或上游 `texts/` 改了而负载没重建。重建后再出图 |
| `lineage` 报 `unknown-prompt` | 该产物用的负载已不在索引里（负载被重建或曾手打投喂） |
| `lineage` 报 `no-metadata` | 该产物没有元数据。本地拼合产物属正常；其它情况请检查 |
| `outputs` 报「缺少同名 .json 元数据」 | 同上。元数据文件名口径是「去掉图片扩展名 + `.json`」 |

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
├── .github/workflows/ci.yml         无依赖校验 + 三层测试 + 脚本语法检查
├── lib/
│   ├── core.mjs                     工作区定位、任务发现、文案解析、负载/血缘/产物校验
│   ├── commands.mjs                 逐字复现命令 + 模型档案 + 环境规则
│   ├── tools.mjs                    whale_meme 的 7 个 action
│   ├── scaffold.mjs                 新任务骨架
│   └── index.mjs                    DSH 接线：工具注册、技能注册、契约注入
├── assets/skill/whale-meme-workflow/SKILL.md
├── scripts/
│   ├── install.ps1                  装进 profile（带备份、可回滚）
│   ├── uninstall.ps1                从 profile 卸载
│   ├── patch-profile.mjs            Node 精确改写 profile 清单
│   └── selftest.mjs                 对真实工作区跑自检
└── test/                            三层测试
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
