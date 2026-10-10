# 贡献指南

先谢谢你有兴趣。这个插件的目标很窄：**把一套已经在跑的表情包绘制工作流，变成一个可校验、可复现的插件**。
所以最受欢迎的贡献是「让某条规则变得可机械判定」，而不是加功能。

## 先做什么

```bash
git clone <仓库地址> && cd dsh-whale-meme
node --test --test-concurrency=1 test/core.test.mjs test/plugin-smoke.test.mjs
node --test --test-concurrency=1 test/integration.test.mjs   # 没有工作区时自动跳过
```

不需要 `npm install`：本插件**不依赖任何第三方 npm 包**，只 import `node:` 内置模块。
如果你发现需要装依赖，先开 issue 讨论——那通常意味着设计走错了方向。

## 项目结构

```
lib/core.mjs       纯逻辑：工作区定位、任务发现、文案解析、负载/血缘/产物校验
lib/commands.mjs   逐字复现命令生成、模型档案、环境规则
lib/tools.mjs      whale_meme 的 action 分发与输出整形
lib/scaffold.mjs   新任务骨架（模板）
lib/index.mjs      DSH 接线：工具注册、技能注册、契约注入（唯一的宿主耦合层）
assets/skill/      技能正文（Markdown）
scripts/           安装、卸载、profile 改写、自检
test/              三层测试
```

**分层的意义**：`core` → `commands` → `tools` 这三层不 import 任何 DSH 包，所以能脱离宿主直接测。
请保持这一点：需要宿主能力时，把它作为参数传进来，不要在底层 import。

## 改动约定

1. **先写测试再改逻辑**（或至少同时）。`test/core.test.mjs` 用临时夹具工作区，
   不依赖任何真实路径；新的判定逻辑请补一条「反例」测试——只测正例说明不了什么。
2. **只读原则**：新增 action 默认必须只读。要写盘的动作必须
   （a）默认 dry-run，（b）需显式 `write: true`，（c）拒绝覆盖已存在的东西。
3. **不写死绝对路径**。需要定位运行时（如 Python）时走环境变量 + `DSH_HOME` 推导 + PATH 退路，
   参考 `lib/commands.mjs` 的 `resolvePython`。
4. **不引入第三方依赖**。用 `node:fs` / `node:path` / `node:crypto` 就够。
5. **中文注释与错误信息**：这个项目的使用者是中文用户。错误信息要能直接指导下一步动作
   （「请设置 DSH_WHALE_ROOT 或插件配置 root」），不要只报「invalid input」。
6. **不要在本仓库放进任何素材**：立绘、参考语料、提示词成品、出图产物一律不进仓库，
   见 [NOTICE.md](NOTICE.md)。测试夹具要用自己造的假数据，不要复制真实语料。

## 提交信息

用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：

```
feat(tools): 新增 outputs 对 1024x2072 拼合尺寸的识别
fix(core): 元数据索引先于图片建立，修掉 _弃用_ 前缀导致的误判
docs(readme): 补上 DSH 终端安装方式
test(core): 补一条负载被改写时应报 payload-drift 的反例
```

## Pull Request

请在 PR 描述里写清：

- **动机**：哪条工作流规则现在只能靠人记，改完之后能被机械判定？
- **验证**：贴出 `node --test` 的实际输出。不要只写「已测试」。
- **反例**：这个改动在什么情况下应该报错？有没有为那种情况写测试？
- **兼容性**：是否改变了现有工作区的目录约定或 action 语义？

维护者可能会要求你把「看起来像功能」的改动改成「看起来像校验」的改动——这是这个项目的取向。

## 报 Bug 时请附上

- 插件版本（`package.json` 的 `version`）
- DSH 版本与平台
- `node scripts/selftest.mjs` 的输出（**先自行脱敏**：去掉绝对路径里的用户名、去掉任何凭据）
- 复现步骤：什么样的工作区、执行了哪个 action

## 安全

请不要在 issue 或 PR 里贴凭据、令牌、cookie。相关说明见 [SECURITY.md](SECURITY.md)。

## 授权

提交贡献即表示你同意把贡献置于本仓库的 [CC0 1.0 Universal](LICENSE) 之下（即贡献到公有领域）。
请确认你有权这么做：**不要**提交属于他人的素材或代码。
