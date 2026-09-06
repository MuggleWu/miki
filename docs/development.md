# 开发指南

## 环境与命令

要求 Node.js 18+（本仓库在 Node 24 上开发）。

```bash
npm install        # 安装依赖（postinstall 会修正 dev 模式的应用名）
npm run dev        # 开发模式（electron-vite dev，renderer 热更新）
npm run build      # 生产构建到 out/
npm start          # 运行构建产物
npm run typecheck  # TypeScript 严格检查（不产出文件）
npm test           # 全部测试（性能基准默认跳过）
```

测试数据与开发数据完全隔离：测试一律用 `os.tmpdir()` 临时目录，跑完即删。

## 项目结构

```
src/
├── shared/          # 主/渲染进程共享类型与默认值（types.ts、ipc.ts）
├── core/            # 纯函数域逻辑，不碰 Electron / 文件系统
│   ├── fsrs.ts      #   FSRS-6 调度器（py-fsrs v6.3.2 逐行移植）
│   ├── replay.ts    #   事件重放（review-log → 卡片状态）
│   ├── queue.ts     #   学习队列与计数（学习 → 到期 → 新卡）
│   ├── query.ts     #   卡片库过滤 / 排序 / 视图行
│   └── stats.ts     #   统计五板块
├── main/            # Electron 主进程
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
| `src/main/__tests__/api-server.spec.ts` | HTTP API 安全链与 CRUD（真实监听临时端口） |
| `src/renderer/src/__tests__/md.spec.ts` | Markdown 渲染 |

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

electron-builder 的图标资源已就位（`build/icon.icns` / `resources/icon.png`），安装器与分发待 M4。
