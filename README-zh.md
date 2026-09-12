# miki

[English](README.md) | 简体中文

本地优先的记忆卡片应用（Anki 替代品）：FSRS-6 调度、事件溯源复习日志、纯文件工作区。

A local-first spaced repetition app — an Anki alternative with FSRS-6 scheduling, built with Electron + React.

## 为什么做 Miki

Anki 是非常优秀的软件，帮助了很多人；FSRS 算法同样非常优秀，能把到期安排控制得很好。但作为个人，我想要的只是满足自己的最小功能集，而不是全部的功能。于是我定制、裁剪出一份自己的版本，这就是 Miki。

它是一个很小的开源项目，可能直到我老去，在这个世界上也不会被人发现。但它存在过——它可以说明我们存在。

## 功能特性

### 调度与复习

- **FSRS-6 调度** — 移植自 py-fsrs v6.3.2，经 550+ 组基准向量比对验证（官方 Python 实现生成期望输出，TS 实现逐例比对）；评级前每个按钮都会预览按下后的下次到期日期
- **每日不限量** — 学习队列到点插回；挡在新卡前面的只有**此刻已到期**的旧卡，今天稍后才到点的复习卡不到点不出
- **Leech 处理** — 累计「重来」次数达到阈值的卡片自动暂停：移出学习队列与全部计数、在卡片库显示 ⏸，可一键解除

### 视图与卡片工作流

- **五个视图** — 牌组（按名称排序的表格）、学习、卡片库、统计、设置；统计页含六个板块：热力图、预测（未来到期）、复习、留存率、卡片数量、复习间隔
- **卡片库** — 多关键词 AND 搜索、列可配置、可拖宽、rotate 排序，侧栏与面板分隔条可拖动，内嵌编辑器实时 Markdown 预览，虚拟滚动支撑万级卡片流畅浏览；到期以两列呈现——「距现在」（相对，如“5 分钟后”）与「到期时间」（绝对，如“2026-09-06 16:49”）
- **独立卡片窗口** — 新增/编辑卡片在可拖出主窗口的独立子窗口进行（可拖到其他屏幕），位置与尺寸跨启动记忆；新增模式连续录卡
- **富卡片内容** — Markdown + KaTeX + 代码高亮

### 数据与工作区

- **纯文件工作区** — 数据存放在独立于应用的文件夹，git 友好，可用任意工具同步
- **多工作区（多用户档案）** — 每个工作区文件夹 = 一份完整档案：牌组、卡片、复习日志与配置各自独立；首次启动引导任选文件夹作为工作区，应用内一键切换档案（自动重启生效），窗口标题显示当前工作区名
- **事件溯源复习日志** — 只追加的 NDJSON；撤销通过自带快照的补偿事件实现
- **百万卡级性能** — 事件溯源架构上的极限优化：历史事件流式重放不驻留内存（百万历史事件重启仅占 22MB）、调度索引增量化（答题 0.12ms、撤销 0.3ms）、检查点 + delta 追加写（撤销写放大从整文件重写降为一次追加，冷启动 5.3s）；测试随机对拍保证调度语义与全量扫描严格一致
- **工作区热加载** — 运行期间外部改动（git pull / 他机写入）自动检测并刷新，无需重启：不中断当前学习（同卡保留答题相位），自写操作不误触发，冲突时会话撤销栈安全作废

### 界面与个性化

- **刷卡字体** — 卡面字体与字号可配置，设置页带实时示例；默认跟随系统字体、16px，与 Obsidian 一致
- **浅色 / 深色主题** — 默认浅色

## 键盘快捷键

单字母快捷键在所有平台一致。应用或本文档中出现 `⌘`（Cmd）的地方，Windows / Linux 用户按 `Ctrl` 即可——例如 `⌘F` 对应 `Ctrl+F`。

| 操作 | macOS | Windows / Linux |
| --- | --- | --- |
| 显示答案 / 评「良好」 | `Space` | `Space` |
| 评「重来 / 困难 / 良好 / 轻松」 | `1` `2` `3` `4` | `1` `2` `3` `4` |
| 学习（**仅首页**）/ 卡片库 / 统计 / 回首页 | `S` `B` `T` `D` | `S` `B` `T` `D` |
| 新增卡片 / 编辑当前卡 | `A` `E` | `A` `E` |
| 删除当前卡 | `⌘D` | `Ctrl+D` |
| 撤销最近答题 / 删除 | `⌘Z` | `Ctrl+Z` |
| 全选当前视图（卡片库） | `⌘A` | `Ctrl+A` |
| 聚焦卡片库搜索框 | `⌘F` | `Ctrl+F` |
| 编辑框加粗选中内容 | `⌘B` | `Ctrl+B` |
| 编辑框切换源码 / 预览 | `` ` `` | `` ` `` |
| 确认新增 / 编辑弹窗 | `⌘Enter` | `Ctrl+Enter` |
| 关闭弹窗 | `Esc` | `Esc` |

在文本框输入时单字母快捷键自动失效，`Ctrl+C/V` 等组合键在输入框内不受影响。`S` 仅在首页生效（从首页进入牌组），其余跳转键在任何位置可用；编辑框里 `⌘B` 加粗、`` ` `` 在源码与预览间切换。

## 开发

```bash
npm install
npm run dev          # 开发模式
npm run build        # 生产构建
npm run pack:mac     # 打包 macOS App（release/mac-arm64/Miki.app）
npm run typecheck    # TypeScript 严格检查（不产出文件）
npm test             # FSRS 基准向量比对 + 核心回归测试
npm run lint         # ESLint，提交前必须 0 error
npm run lint:fix     # 自动修复 lint 问题
npm run format       # Prettier 写入
npm run format:check # 仅检查格式
npm start            # 运行构建产物
```

支持 macOS、Windows、Linux（标准 Electron 窗口，无平台专属 API）。

## 打包与安装（macOS）

`npm run pack:mac` 用 electron-builder 产出独立 App：`release/mac-arm64/Miki.app`——Dock 与菜单栏显示 Miki、自带应用图标（appId `com.mugglewu.miki`），本地构建不做签名。复制到 `/Applications` 后即可从 **Raycast（输入 `miki`）**、Spotlight 或 Dock 启动；应用全局单实例，重复启动只唤起已有窗口。

打包版的工作区解析：`MIKI_WORKSPACE` 环境变量 → `~/Library/Application Support/Miki/workspace.json` 的 `current`（同时保存多工作区注册表，旧 `{workspacePath}` 格式自动升级）→ 首次启动引导（建议默认 `~/miki-base`）。打包流程、LaunchServices 注册等工作区配置细节见 [docs/zh/development.md](docs/zh/development.md)「打包」一节。

## Android 移动端

仓库里还有一个 Android 客户端（`mobile-android/`）：复用同一份调度与数据层逻辑，套 Capacitor 壳跑在手机上，界面是面向触屏的另一套页面（牌组 / 学习 / 卡片库 / 统计 / 设置，另有设备自检页）。

```bash
cd mobile-android && npm install
npm run build && npx cap sync android
cd android && ./gradlew assembleDebug   # → android/app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

桌面端与手机之间通过**一个私有 git 仓库**同步：手机端做「拉取 → 行合并 → 推送」，两端各自追加的事件按行并集合并；如果两侧都改了同一份 JSON（`decks.json` / `config.json`），同步会停下来要求先去桌面端定夺，绝不猜。在手机的「设置 → 配置同步」里填仓库与细粒度 PAT（需要该仓库的 Contents 读写权限），点「立即同步」即把工作区拉到手机上。

移动端 v1 的边界：只追加、不压实（压实留在桌面端）；工作区由同步建立，也可以先在手机上自建牌组试用。客户端有独立文档：[mobile-android/README.md](mobile-android/README.md)（English: [mobile-android/README.en.md](mobile-android/README.en.md)）；构建、门禁与测试细节见 [docs/zh/development.md](docs/zh/development.md) 的「Android 移动端」一节。

## HTTP API 与 MCP

Miki 内置本机 HTTP API，供人和 AI 程序化管理牌组与卡片（增删改查，含批量）。只监听 `127.0.0.1:8727`，必须携带 token，拒绝浏览器发起的跨站请求。详见 [docs/zh/api.md](docs/zh/api.md)。

MCP 客户端可用附带的 stdio 薄壳接入——推荐自动发现（无需配置，始终跟随当前工作区；切换工作区后重启 MCP 即可）：

```bash
node scripts/mcp-server.mjs
```

也可显式指定 token 与端口（旧行为）：`MIKI_TOKEN=$(`cat <工作区>/.miki/api-token`) node scripts/mcp-server.mjs`。

提供 14 个工具：`list_decks`、`create_decks`、`rename_deck`、`delete_deck`、`search_cards`、`get_cards`、`add_cards`、`update_cards`、`move_cards`、`set_suspended`、`delete_cards`、`reset_progress`、`get_stats`、`api_schema`（最后一个返回本机 HTTP API 的 OpenAPI 描述，供 AI 了解全部端点后直接用 HTTP 调用）。批量工具单次最多 500 张卡；`search_cards` 日期参数接受 `YYYY-MM-DD`，按本地零点解析。

## 文档

更多文档在 [docs/](docs/)（分 `en` / `zh` 两个语种目录）：

- [使用手册](docs/zh/usage.md) — 五视图操作、鼠标交互与快捷键总表
- [工作区数据格式](docs/zh/data-format.md) — 目录结构、事件协议与重放规则
- [HTTP API](docs/zh/api.md) — 端点、认证与安全边界
- [开发指南](docs/zh/development.md) — 项目结构、测试组织与 FSRS 基准向量

English versions live in [docs/en/](docs/en/).

## 工作区格式

数据存放在一个纯文件夹中（由 `MIKI_WORKSPACE` 环境变量、工作区指针文件或首次启动引导解析——建议默认 `~/miki-base`）：

```
config.json                        # 应用配置（FSRS 参数、主题、刷卡字体、leech 阈值、卡片库与首页布局）
decks.json                         # 牌组列表
stats.json                         # 统计聚合检查点（热力图聚合 + 事件水位）
cards/<deck-id>.ndjson             # 卡片基文件（检查点快照行，含 suspended 暂停标记）
cards/<deck-id>.delta.ndjson       # 卡片增量变更（编辑 / 移动 / 墓碑），只追加
review-log/<yyyy-mm>.ndjson        # 只追加的复习事件（answer / delete / undo / reset / suspend）
```

`review-log` 是调度状态的真理来源；卡片基文件 + delta 是内容真理的检查点形式，两者以事件水位对齐。完整字段、压实规则与重放协议见 [docs/zh/data-format.md](docs/zh/data-format.md)。

## 致谢

谨以此作品，献给我的妻子 meihua 女士。

- [Anki](https://apps.ankiweb.net/) — 让间隔重复成为大众工具的黄金标准，也是 Miki 存在的原因
- [FSRS](https://github.com/open-spaced-repetition/fsrs4anki) 与 [py-fsrs](https://github.com/open-spaced-repetition/py-fsrs) — 开源调度算法及其参考实现，Miki 的调度器移植自它并经基准向量比对验证
- Miki 所站立的开源肩膀：Electron、React、Vite、ECharts、markdown-it、KaTeX、Shiki

## 许可证

[MIT](LICENSE)
