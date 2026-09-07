# miki

[English](README.md) | 简体中文

本地优先的记忆卡片应用（Anki 替代品）：FSRS-6 调度、事件溯源复习日志、纯文件工作区。

A local-first spaced repetition app — an Anki alternative with FSRS-6 scheduling, built with Electron + React.

## 为什么做 Miki

Anki 是非常优秀的软件，帮助了很多人；FSRS 算法同样非常优秀，能把到期安排控制得很好。但作为个人，我想要的只是满足自己的最小功能集，而不是全部的功能。于是我定制、裁剪出一份自己的版本，这就是 Miki。

它是一个很小的开源项目，可能直到我老去，在这个世界上也不会被人发现。但它存在过——它可以说明我们存在。

## 功能特性

- **FSRS-6 调度** — 移植自 py-fsrs v6.3.2，经 550+ 组基准向量比对验证（官方 Python 实现生成期望输出，TS 实现逐例比对）；评级前每个按钮都会预览按下后的下次到期日期
- **五个视图** — 牌组（按名称排序的表格）、学习、卡片库、统计（预测 / 热力图 / 复习 / 卡片状态 / 复习间隔）、设置
- **Leech 处理** — 累计「重来」次数达到阈值的卡片自动暂停：移出学习队列与全部计数、在卡片库显示 ⏸，可一键解除
- **卡片库** — 多关键词 AND 搜索、列可配置、可拖宽、rotate 排序，侧栏与面板分隔条可拖动，内嵌编辑器实时 Markdown 预览，虚拟滚动支撑万级卡片流畅浏览；到期以两列呈现——「距现在」（相对，如“5 分钟后”）与「到期时间」（绝对，如“2026-09-06 16:49”）
- **刷卡字体** — 卡面字体与字号可配置，设置页带实时示例；默认跟随系统字体、16px，与 Obsidian 一致
- **富卡片内容** — Markdown + KaTeX + 代码高亮
- **事件溯源复习日志** — 只追加的 NDJSON；撤销通过自带快照的补偿事件实现
- **百万卡级性能** — 事件溯源架构上的极限优化：历史事件流式重放不驻留内存（百万历史事件重启仅占 22MB）、调度索引增量化（答题 0.12ms、撤销 0.3ms）、检查点 + delta 追加写（撤销写放大从整文件重写降为一次追加，冷启动 5.3s）；测试随机对拍保证调度语义与全量扫描严格一致
- **纯文件工作区** — 数据存放在独立于应用的文件夹，git 友好，可用任意工具同步
- **工作区热加载** — 运行期间外部改动（git pull / 他机写入）自动检测并刷新，无需重启：不中断当前学习（同卡保留答题相位），自写操作不误触发，冲突时会话撤销栈安全作废
- **浅色 / 深色主题** — 默认浅色
- **每日不限量** — 学习队列到点插回，当日旧卡（含今日稍后到点的复习卡）全部清完才出新卡：刷完旧卡才能刷新卡

## 键盘快捷键

单字母快捷键在所有平台一致。应用或本文档中出现 `⌘`（Cmd）的地方，Windows / Linux 用户按 `Ctrl` 即可——例如 `⌘F` 对应 `Ctrl+F`。

| 操作 | macOS | Windows / Linux |
| --- | --- | --- |
| 显示答案 / 评「良好」 | `Space` | `Space` |
| 评「重来 / 困难 / 良好 / 轻松」 | `1` `2` `3` `4` | `1` `2` `3` `4` |
| 学习 / 卡片库 / 统计 / 回首页 | `S` `B` `T` `D` | `S` `B` `T` `D` |
| 新增卡片 / 编辑当前卡 | `A` `E` | `A` `E` |
| 删除当前卡 | `⌘D` | `Ctrl+D` |
| 撤销最近答题 / 删除 | `⌘Z` | `Ctrl+Z` |
| 聚焦卡片库搜索框 | `⌘F` | `Ctrl+F` |
| 确认新增 / 编辑弹窗 | `⌘Enter` | `Ctrl+Enter` |
| 关闭弹窗 | `Esc` | `Esc` |

在文本框输入时单字母快捷键自动失效，`Ctrl+C/V` 等组合键在输入框内不受影响。

## 开发

```bash
npm install
npm run dev        # 开发模式
npm run build      # 生产构建
npm run pack:mac   # 打包 macOS App（release/mac-arm64/Miki.app）
npm run typecheck  # TypeScript 严格检查（不产出文件）
npm test           # FSRS 基准向量比对 + 核心回归测试
npm start          # 运行构建产物
```

支持 macOS、Windows、Linux（标准 Electron 窗口，无平台专属 API）。

## 打包与安装（macOS）

`npm run pack:mac` 用 electron-builder 产出独立 App：`release/mac-arm64/Miki.app`——Dock 与菜单栏显示 Miki、自带应用图标（appId `com.mugglewu.miki`），本地构建不做签名。复制到 `/Applications` 后即可从 **Raycast（输入 `miki`）**、Spotlight 或 Dock 启动；应用全局单实例，重复启动只唤起已有窗口。

打包版的工作区解析：`MIKI_WORKSPACE` 环境变量 → `~/Library/Application Support/Miki/workspace.json`（`{"workspacePath": …}`）→ 缺省 `~/miki-base`。打包流程、LaunchServices 注册等工作区配置细节见 [docs/development.md](docs/development.md)「打包」一节。

## HTTP API 与 MCP

Miki 内置本机 HTTP API，供人和 AI 程序化管理牌组与卡片（增删改查，含批量）。只监听 `127.0.0.1:8727`，必须携带 token，拒绝浏览器发起的跨站请求。详见 [docs/api.md](docs/api.md)。

MCP 客户端可用附带的 stdio 薄壳接入：

```bash
MIKI_TOKEN=<config.json 中的 api.token> node scripts/mcp-server.mjs
```

提供 `list_decks`、`add_cards`、`search_cards`、`update_cards`、`move_cards`、`delete_cards`、`reset_progress`、`get_stats` 等工具。

## 文档

更多文档在 [docs/](docs/)：

- [使用手册](docs/usage.md) — 五视图操作、鼠标交互与快捷键总表
- [工作区数据格式](docs/data-format.md) — 目录结构、事件协议与重放规则
- [HTTP API](docs/api.md) — 端点、认证与安全边界
- [开发指南](docs/development.md) — 项目结构、测试组织与 FSRS 基准向量

## 工作区格式

数据存放在一个纯文件夹中（由 `MIKI_WORKSPACE` 环境变量解析，缺省回落到 `~/miki-base`）：

```
config.json                        # 应用配置（FSRS 参数、主题、刷卡字体、leech 阈值、卡片库与首页布局）
decks.json                         # 牌组列表
stats.json                         # 统计聚合检查点（热力图聚合 + 事件水位）
cards/<deck-id>.ndjson             # 卡片基文件（检查点快照行，含 suspended 暂停标记）
cards/<deck-id>.delta.ndjson       # 卡片增量变更（编辑 / 移动 / 墓碑），只追加
review-log/<yyyy-mm>.ndjson        # 只追加的复习事件（answer / delete / undo / reset / suspend）
```

`review-log` 是调度状态的真理来源；卡片基文件 + delta 是内容真理的检查点形式，两者以事件水位对齐。完整字段、压实规则与重放协议见 [docs/data-format.md](docs/data-format.md)。

## 致谢

谨以此作品，献给我的妻子 meihua 女士。

- [Anki](https://apps.ankiweb.net/) — 让间隔重复成为大众工具的黄金标准，也是 Miki 存在的原因
- [FSRS](https://github.com/open-spaced-repetition/fsrs4anki) 与 [py-fsrs](https://github.com/open-spaced-repetition/py-fsrs) — 开源调度算法及其参考实现，Miki 的调度器移植自它并经基准向量比对验证
- Miki 所站立的开源肩膀：Electron、React、Vite、ECharts、markdown-it、KaTeX、highlight.js

## 许可证

[MIT](LICENSE)
