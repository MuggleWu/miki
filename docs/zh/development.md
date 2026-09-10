# 开发指南

[English](../en/development.md) | 简体中文

## 环境与命令

要求 Node.js 18+（本仓库在 Node 24 上开发）。

```bash
npm install        # 安装依赖（postinstall 会修正 dev 模式的应用名）
npm run dev        # 开发模式（electron-vite dev，renderer 热更新）
npm run build      # 生产构建到 out/
npm start          # 运行构建产物
npm run typecheck  # TypeScript 严格检查（不产出文件）
npm test           # 全部测试（性能基准默认跳过）
npm run lint       # ESLint：提交前必须 0 error
npm run lint:fix   # 自动修复 lint 问题
npm run format     # Prettier 写入
npm run format:check # 仅检查格式
```

测试数据与开发数据完全隔离：测试一律用 `os.tmpdir()` 临时目录，跑完即删。

## 项目结构

```
src/
├── shared/          # 主/渲染进程共享类型与默认值（types.ts、ipc.ts、workspace.ts、card-dialog.ts）
├── core/            # 纯函数域逻辑，不碰 Electron / 文件系统
│   ├── fsrs.ts      #   FSRS-6 调度器（py-fsrs v6.3.2 逐行移植）
│   ├── replay.ts    #   事件重放（review-log → 卡片状态）
│   ├── queue.ts     #   学习队列与计数（学习到点 → 当日复习 → 新卡）
│   ├── query.ts     #   卡片库过滤 / 排序 / 视图行
│   └── stats.ts     #   统计六板块（含留存率）
├── main/            # Electron 主进程
│   ├── workspace-manager.ts #   多工作区（多用户档案）注册表：指针文件读写、引导确认、切换
│   ├── workspace.ts #   WorkspaceService：唯一写入口（内存态 + 同步落盘）
│   ├── api-server.ts#   本机 HTTP API（127.0.0.1，token 鉴权）
│   └── index.ts     #   启动、IPC 注册、窗口
├── preload/         # contextBridge：window.miki
└── renderer/src/    # React 界面（home / study / browser / stats / settings）
tools/               # FSRS 基准向量生成脚本（Python，py-fsrs 官方实现）
scripts/mcp-server.mjs  # MCP stdio 薄壳（转发 HTTP API）
docs/                # 本目录
```

关键约束：

- **`core/` 不允许 import Electron 或 node:fs**——它是纯函数层，调度正确性由基准向量锁定，这样才有测试价值。
- **所有写路径都走 `WorkspaceService`**：先落盘（原子写 / 追加），后更新内存；review-log 是调度真理来源，卡片文件是内容真理来源，两者以事件水位对齐（见 [data-format.md](data-format.md)）。
- **单事件应用只有一份语义**：`core/replay.ts` 的 `applyEvent` 同时服务全量重放与启动流式重放，改语义两处自然同步。
- **调度索引语义以全量扫描为基准**：`schedule-index.spec.ts` 用 200 步随机操作对拍索引取卡/计数与全量扫描，保证增量结构不漂移。
- 代码与用户数据物理分离：仓库里不出现任何真实卡片内容与工作区路径。

## 测试

| 套件 | 内容 |
| --- | --- |
| `src/core/__tests__/fsrs.spec.ts` | FSRS-6 基准向量比对：552 组固定输入的期望输出由 py-fsrs v6.3.2 官方实现生成（tools/ 下脚本），TS 实现逐例比对 state/step/stability/difficulty/due |
| `src/core/__tests__/core.spec.ts` | replay / queue / query / stats 口径 |
| `src/main/__tests__/workspace.spec.ts` | 服务层不变量：undo 语义、leech、suspend 事件化、重放一致性、事件不驻留、损坏容错、配置持久化 |
| `src/main/__tests__/schedule-index.spec.ts` | 调度索引对拍：200 步随机操作（答题/撤销/删除/暂停/重置/跨天）后，索引取卡与计数逐牌组比对全量扫描基准 |
| `src/main/__tests__/checkpoint.spec.ts` | 检查点 + delta 写路径：调度类操作零卡片写、move 墓碑往返幂等、压实前后一致、stats.json 增量重放、旧格式兼容 |
| `src/main/__tests__/api-server.spec.ts` | HTTP API 安全链与 CRUD（真实监听临时端口）：鉴权/Origin/Host 校验、HEAD 镜像 GET、suspend 严格布尔、到期窗口两入口口径、分页 clamp |
| `src/main/__tests__/card-dialog.spec.ts` | 独立卡片窗口管理器：open 载荷、位置尺寸持久化、主窗关闭联动 |
| `src/main/__tests__/workspace-manager.spec.ts` | 多工作区注册表：指针文件升级、引导确认、切换/添加/移除 |
| `src/renderer/src/__tests__/md.spec.ts` | Markdown 渲染 |
| `src/renderer/src/__tests__/highlighter.spec.ts` | Shiki 代码高亮与 markdown 集成 |
| `src/renderer/src/__tests__/backtick.spec.ts` | 编辑器反引号快捷包裹（单按行内代码、三连按围栏） |
| `src/renderer/src/__tests__/bold.spec.ts` | 编辑器选区加粗开关 |
| `src/renderer/src/__tests__/list.spec.ts` | 编辑器列表续行（有序递增、缩进沿用、空项退出） |
| `src/renderer/src/__tests__/paginate.spec.ts` | 卡片库分页取数守卫（含状态/到期过滤参与视图签名与追加页丢弃） |
| `src/renderer/src/__tests__/staleGuard.spec.ts` | 异步竞态防护：旧响应晚到不覆盖新数据 |
| `src/renderer/src/__tests__/debouncedPersist.spec.ts` | 选中态防抖落盘 |
| `src/renderer/src/__tests__/numericDraft.spec.tsx` | 设置页数值草稿：防抖/flush/卸载兜底、回声抑制多重集 |
| `src/renderer/src/__tests__/studyAnswerGuard.spec.tsx` | 学习页评级在途闸门：连按/混按只发一次 answer（jsdom + React 真行为） |
| `src/renderer/src/__tests__/browserAutosave.spec.tsx` | 卡片库编辑自动保存：切卡/卸载/卡被删除时都先落盘在途编辑（jsdom + React 真行为） |
| `src/renderer/src/__tests__/browserFilters.spec.ts` | 卡片库过滤档：状态档定义、到期窗口换算与互补边界、非法档位归一 |
| `src/renderer/src/__tests__/browserFilterUi.spec.tsx` | 卡片库过滤 UI 到 IPC 链路：选档后 queryCards 入参、落 config、清除过滤（jsdom + React 真行为） |
| `src/shared/__tests__/config-boundary.spec.ts` | 渲染层可写配置白名单：api.token/调度参数/workspacePath 不得被渲染层整份覆盖 |

### FSRS 基准向量再生成

需要 Python 3 与 `typing_extensions`，以及 /tmp 下的 py-fsrs v6.3.2 检出：

```bash
python3 tools/gen-fsrs-vectors.py            # 固定场景 → tools/fsrs-vectors.json
python3 tools/gen-fsrs-vectors-random.py     # 随机参数 507 例 → tools/fsrs-vectors-random.json
```

随机脚本种子固定（20260906），输出可复现；fuzz 开启时输出含随机数，无法生成固定期望，其逻辑以与 py-fsrs 源码逐行对照为准。

### 性能基准

```bash
MIKI_BENCH=1 npx vitest run src/main/__tests__/perf.spec.ts
MIKI_BENCH_N=1000000 MIKI_BENCH=1 npx vitest run src/main/__tests__/perf.spec.ts  # 百万卡极限
MIKI_BENCH=1 NODE_OPTIONS=--expose-gc npx vitest run src/main/__tests__/minevents.spec.ts  # 事件不驻留验收
```

默认跳过，不影响 `npm test`。perf.spec 输出各核心操作耗时表（导入 / 查询 / 答题 / 重放 / 批量删除 / 撤销）；minevents.spec 构造 100 万历史事件重启，断言 `events` 不驻留且 heapUsed 远低于事件总量（需 `--expose-gc` 排除 parse 垃圾干扰）。

百万卡参考值（2026-09-06，M 系列笔记本）：答题 0.12ms/次、撤销 0.3ms、批量删 1000 张 6.1ms、冷启动 5.3s、百万历史事件重启 heapUsed 22MB。

## FSRS 升级路径

`core/fsrs.ts` 是 py-fsrs scheduler 的逐行移植（含 Python banker's rounding 与 timedelta floor 语义的复刻）。py-fsrs 发布新版本后：diff 官方 `scheduler.py`，同步改动，再用基准向量脚本对固定输入重新生成期望输出——向量不一致即移植有误或语义变化。

## 打包

- `npm run pack:mac`：electron-vite build + electron-builder（`--dir` 目标，配置在 package.json 的 `build` 字段），产物 `release/mac-arm64/Miki.app`（arm64；appId `com.mugglewu.miki`，图标 `resources/icon.png` 1024²，本地构建不做签名 `identity: null`）。
- 安装：`cp -R release/mac-arm64/Miki.app /Applications/` 后 `open /Applications/Miki.app`；新装应用按名字启动（`open -a Miki` / Raycast 搜 "miki"）需等 LaunchServices 索引，或用 `lsregister -f /Applications/Miki.app` 立即注册。
- 工作区解析（`main/workspace-manager.ts`）：`MIKI_WORKSPACE` 环境变量 → 指针文件 `~/Library/Application Support/Miki/workspace.json` 的 `current`（含多工作区注册表 `workspaces[]`，旧 `{workspacePath}` 格式自动升级）→ 都没有时进入首次启动引导（渲染层 `WorkspaceOnboarding`），用户任选文件夹后主进程才 `ws.init` 并启动热加载与 HTTP API。
- 单实例锁：`app.requestSingleInstanceLock()`，第二个实例静默退出并唤起已有窗口（防 Raycast 与 dev 双开并发写同一工作区）。
- 工作区热加载（`WorkspaceService.startWatching()`，默认 2s 轮询）：受管文件 = `decks.json` / `config.json` / `stats.json` / `cards/*.ndjson`（含 delta）/ `review-log/*.ndjson`，按 `mtime+size` 指纹与上次快照比对；发现外部变化（git pull、他机写入）后主进程全量重建内存态（与启动加载链同语义），再经 `miki:workspace-changed` 事件通知渲染进程刷新当前视图。要点：
  - **自写豁免**：本机所有写路径（原子写/追加）完成后立即更新快照，不把自己的写入当外部变更——若漏挂一处，也只多一次全量重载，不会死循环（重载结束重扫快照）；
  - **冷却**：3s 内重复变化合并（置 dirty），git pull 大操作期间最多每 3s 重载一次；
  - **撤销栈作废**：外部变更后撤销目标可能失效（卡被改/删、事件行序变化），重载即清空会话撤销栈（D2 仅本会话）；
  - **不主动压实**：热加载不清 delta、不折叠他人刚同步的文件，只在内存中重建（压实阈值从零重新计数，与重启一致）。
