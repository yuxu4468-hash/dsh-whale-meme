# Changelog

本文件记录本插件的所有值得注意的变化。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

暂无。

## [0.1.0] - 2026-10-10

首个版本。把「表情包绘制工作区」的工作流固化为 DSH 插件。

### Added

- **`whale_meme` 工具**，7 个 action：
  - `status` — 工作区全景：阶段归属、任务清单、负载与产物现状
  - `task` — 单任务逐字文案、必须加粗的字、五件套齐备度
  - `payload` — 投喂负载逐字一致性（磁盘字节 sha256 + 正文是否仍出现在来源文件里）
  - `lineage` — 产物元数据 `prompt.sha256` ↔ 负载索引对齐
  - `outputs` — 产物尺寸、透明通道、推荐交付件、元数据齐全度
  - `commands` — 8 个步骤的逐字复现命令（`build`/`mother`/`upper`/`lower`/`whole`/`compose`/`check`/`index`）
  - `scaffold` — 新任务骨架，默认 dry-run，拒绝覆盖已占用任务号
- **`whale-meme-workflow` 技能**：四段流水线、两个图像模型差异表、编辑链、7 条环境坑、
  验收五组、合规底线、新任务开局顺序。
- **工作流契约注入**：加载时把角色剪影三要素、目录归属与硬规则追加到工作区上下文。
- **安装/卸载脚本**：`scripts/install.ps1` / `scripts/uninstall.ps1`，
  带时间戳备份、失败自动回滚；`scripts/patch-profile.mjs` 用 Node 精确改写 profile 清单
  （不写 BOM、保持原缩进与换行、不转义中文）。
- **三层测试**：纯逻辑（临时夹具）、宿主接线（假 Cordis 上下文）、真实工作区集成（不在时自动跳过）。
- **真实工作区自检**：`scripts/selftest.mjs`，可输出人读报告或 `--json`。

### Notes

- 无构建步骤：`lib/*.mjs` 是原生 ESM，DSH 直接加载。修改源码立即生效（Junction 装法）。
- 除 `scaffold` 写盘分支外，所有 action 只读。
- 插件不 import 任何第三方 npm 包，没有需要随附的第三方许可证。

### Fixed

开发过程中定位并修掉的问题，一并记录以便复现同类缺陷：

- 元数据索引顺序：真实目录里 `_弃用_*.png` 排在数字命名之前，若先扫图片再建 JSON 索引，
  会把所有图误判为「缺元数据」。改为两遍扫描，并补了回归测试。
- 元数据文件名口径：出图客户端写的是「去掉图片扩展名 + `.json`」，早期实现按 `<图片全名>.json`
  查找所以匹配不到。
- `lineage` 判据：`ok` 原本要求「每张产物都有元数据」，但本地拼合产物本来就不写元数据；
  改为「没有任何产物对不上索引」，缺元数据的单列警告。
- 负载来源解析：解析来源标签里的文件名时，正则的字符类把第一个 `.` 当分界，
  只匹配到 `_GPT-Image-2.5.md` 这种残片。改为从标签开头吃到 `.md`。
- Python 解释器定位：原本内置了一条写死用户名的主机绝对路径作为回退。改为
  `DSH_WHALE_PYTHON` → `DSH_HOME` 推导（含 Windows 与 POSIX 布局）→ PATH 里的 `python`，
  换机器不用改代码，公开仓库也不再带个人路径。

[Unreleased]: https://github.com/yuxu4468-hash/dsh-whale-meme/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/yuxu4468-hash/dsh-whale-meme/releases/tag/v0.1.0
