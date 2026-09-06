# miki

[English](README.md) | 简体中文

本地优先的记忆卡片应用（Anki 替代品）：FSRS-6 调度、事件溯源复习日志、纯文件工作区。

A local-first spaced repetition app — an Anki alternative with FSRS-6 scheduling, built with Electron + React.

## 功能特性

- **FSRS-6 调度** — 移植自 py-fsrs v6.3.2，经 550+ 组基准向量比对验证（官方 Python 实现生成期望输出，TS 实现逐例比对）；评级前每个按钮都会预览按下后的下次到期日期
- **五个视图** — 牌组（按名称排序的表格）、学习、卡片库、统计（预测 / 热力图 / 复习 / 卡片状态 / 复习间隔）、设置
- **Leech 处理** — 累计「重来」次数达到阈值的卡片自动暂停：移出学习队列与全部计数、在卡片库显示 ⏸，可一键解除
- **卡片库** — 多关键词 AND 搜索、列可配置、可拖宽、rotate 排序，侧栏与面板分隔条可拖动，内嵌编辑器实时 Markdown 预览；到期以两列呈现——「距现在」（相对，如“5 分钟后”）与「到期时间」（绝对，如“2026-09-06 16:49”）
- **刷卡字体** — 卡面字体与字号可配置，设置页带实时示例；默认跟随系统字体、16px，与 Obsidian 一致
- **富卡片内容** — Markdown + KaTeX + 代码高亮
- **事件溯源复习日志** — 只追加的 NDJSON；撤销通过自带快照的补偿事件实现
- **纯文件工作区** — 数据存放在独立于应用的文件夹，git 友好，可用任意工具同步
- **浅色 / 深色主题** — 默认浅色
- **每日不限量** — 先学习队列，再到期复习，最后新卡

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
npm run typecheck  # TypeScript 严格检查（不产出文件）
npm test           # FSRS 基准向量比对 + 核心回归测试
npm start          # 运行构建产物
```

支持 macOS、Windows、Linux（标准 Electron 窗口，无平台专属 API）。二进制打包与安装器后续提供，当前请从源码运行。

## HTTP API 与 MCP

Miki 内置本机 HTTP API，供人和 AI 程序化管理牌组与卡片（增删改查，含批量）。只监听 `127.0.0.1:8727`，必须携带 token，拒绝浏览器发起的跨站请求。详见 [API.md](API.md)。

MCP 客户端可用附带的 stdio 薄壳接入：

```bash
MIKI_TOKEN=<config.json 中的 api.token> node scripts/mcp-server.mjs
```

提供 `list_decks`、`add_cards`、`search_cards`、`update_cards`、`move_cards`、`delete_cards`、`reset_progress`、`get_stats` 等工具。

## 工作区格式

数据存放在一个纯文件夹中（由 `MIKI_WORKSPACE` 环境变量解析，缺省回落到 `~/miki-base`）：

```
config.json                     # 应用配置（FSRS 参数、主题、刷卡字体、leech 阈值、卡片库与首页布局）
decks.json                      # 牌组列表
cards/<deck-id>.ndjson          # 卡片内容，每行一个 JSON 对象（含 suspended 暂停标记）
review-log/<yyyy-mm>.ndjson     # 只追加的复习事件（answer / delete / undo / reset）
```

`review-log` 是调度状态的唯一真理来源；卡片状态通过重放事件重建。

## 许可证

[MIT](LICENSE)
