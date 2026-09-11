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
mobile-android/      # Android 客户端（Capacitor 壳 + 复用 core/shared 的 React 界面）
├── src/mobile/      #   移动端实现：FileStore 抽象、加载链、写路径、调度会话、同步
├── src/ui/          #   移动端界面（牌组 / 学习 / 卡片库 / 统计 / 设置 + 抽屉导航）
└── android/         #   Capacitor 的 Android 工程（gradle 构建、签名、安装）
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

### 关窗落盘为什么用同步 IPC

`IPC.flushPendingEdit` 是本仓库唯一一条同步通道（preload 用 `ipcRenderer.sendSync`，
主进程用 `ipcMain.on` + `event.returnValue` 配对）。它存在的理由不是性能，是**唯一能
保证写完再返回**的做法：

- 卡片库的编辑落盘有 800ms 防抖，正常路径靠「防抖计满 / 切卡 / 组件卸载清理」三处触发；
- 关窗与退出这条路径上 React 不会执行卸载清理（进程直接结束），jsdom 里的
  `root.unmount()` 用例覆盖不到它，必须靠渲染层监听 `beforeunload`；
- 而 `beforeunload` 里**不能**用普通的异步 `ipcRenderer.invoke`：消息发出去后进程可能
  先被销毁，写盘不保证完成，用户最后那次编辑照样丢。`sendSync` 会阻塞渲染进程直到主
  进程写完，所以这一处刻意保持同步。

真机验证结论（Electron 33，真实 out/main + 真实 preload + 真实渲染产物，工作区用真实
数据副本）：`win.close()` / `app.quit()` / 页面 `window.close()` 三条路径上 `beforeunload`
都会触发，渲染层确实调用同步通道，写入落在 `cards/<deck>.delta.ndjson`；摘掉渲染层的
`beforeunload` 注册后同一条用例变成「同步通道 0 次调用 + 读回旧内容」，即编辑丢失。

两个容易踩的坑，改这块代码前先看一眼：

- **别把它改成异步 invoke**：改了在开发机上大概率仍能通过（进程还没死），但真实关窗
  时就会丢最后一次编辑，而这恰恰是它要解决的场景。
- **基文件不是立即更新的**：关窗写入落在 `.delta.ndjson`，`<deck>.ndjson` 只在压实时
  合并，所以「关窗后直接读基文件发现是旧内容」是正常现象，判断落盘要看 delta 或用
  `WorkspaceService.getCard` 读回。
- **删除/移出不写卡片文件**，只写 review-log 与内存态；靠 `pendingDeletes` 计数（20 条）
  触发压实才落进基文件。所以 `compactDeck` 的「没有 delta 就跳过」前提必须带上这个计数，
  否则这条路径永远压不动，而只读基文件的程序会把已删除的卡当成还在。改这里时注意
  `bumpPendingDeletes` 的 n 要按**条数**（一次批量移动可能带多个 id）。
- 启动结算（`compactStaleDeletions`）读的是**加载期快照**：基文件删除标记必须在 delta 合并前
  采样，因为 delta 的内容覆盖行会改写 `deletedAt`，合完就分不清「基文件本身落没落盘」。
  该快照只用于这一次结算，之后清空，所以热加载不会反复重写基文件。

## 测试

| 套件 | 内容 |
| --- | --- |
| `src/core/__tests__/fsrs.spec.ts` | FSRS-6 基准向量比对：552 组固定输入的期望输出由 py-fsrs v6.3.2 官方实现生成（tools/ 下脚本），TS 实现逐例比对 state/step/stability/difficulty/due |
| `src/core/__tests__/core.spec.ts` | replay / queue / query / stats 口径 |
| `src/main/__tests__/workspace.spec.ts` | 服务层不变量：undo 语义、leech、suspend 事件化、重放一致性、事件不驻留、损坏容错、配置持久化 |
| `src/main/__tests__/schedule-index.spec.ts` | 调度索引对拍：200 步随机操作（新增/答题/撤销/删除/暂停/重置/跨牌组移动）后，索引取卡与计数逐牌组比对全量扫描基准 |
| `src/main/__tests__/checkpoint.spec.ts` | 检查点 + delta 写路径：调度类操作零卡片写、move 墓碑往返幂等、压实前后一致、stats.json 增量重放、旧格式兼容 |
| `src/main/__tests__/api-server.spec.ts` | HTTP API 安全链与 CRUD（真实监听临时端口）：鉴权/Origin/Host 校验、HEAD 镜像 GET、suspend 严格布尔、到期窗口两入口口径、分页 clamp |
| `src/main/__tests__/card-dialog.spec.ts` | 独立卡片窗口管理器：open 载荷、位置尺寸持久化、主窗关闭联动 |
| `src/main/__tests__/workspace-manager.spec.ts` | 多工作区注册表：指针文件升级、引导确认、切换/添加/移除 |
| `src/main/__tests__/session-log.spec.ts` | 会话事件日志：seq 与索引同生同灭、撤销栈、每卡最近 suspend 索引 |
| `src/main/__tests__/workspace-io.spec.ts` | NDJSON 行读原语：语义与旧实现逐样本对拍（CRLF/空行/超长行）、惰性提前退出 |
| `src/renderer/src/__tests__/highlighter.spec.ts` | Shiki 代码高亮、懒加载契约（就绪前返回 null、按语言加载、别名解析）与 markdown 集成 |
| `src/renderer/src/__tests__/md.spec.tsx` | Markdown 渲染（KaTeX）与 Md 的引擎就绪重渲染补色 |
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
| `src/main/__tests__/workspace-registry.spec.ts` | 多工作区注册表纯函数：normalizeRegistry 信任边界、upsert/remove、旧指针格式兼容 |
| `src/renderer/src/__tests__/browserPaginationWiring.spec.tsx` | 卡片库分页「接线」：滚到底预取的追加页必须真的进 React 状态（曾经只落在 paginator 闭包里，滚过首屏后表格空白）；外部焦点定位（B 键）翻到目标卡所在页 |
| `src/renderer/src/__tests__/cardSubmitGuard.spec.tsx` | 卡片表单提交重入防护：await 期间双击 / ⌘Enter 连按只产生一次写入 |
| `src/renderer/src/__tests__/dialogOptimisticLock.spec.tsx` | 编辑弹窗乐观锁：检测到别处改动时不写盘、明确提示、不关窗丢内容 |
| `src/renderer/src/__tests__/undoDiscardedNotice.spec.tsx` | 热加载作废撤销栈时给出可见提示（否则用户看到的是「按 ⌘Z 没反应」） |
| `src/renderer/src/__tests__/dragState.spec.ts` | 拖动计数自愈：mouseup 丢失（拖出窗口松手）后计数不残留，后续拖动仍生效 |
| `src/renderer/src/__tests__/errorBoundary.spec.tsx` | 渲染错误边界：抛错时不白屏、提示可见、重试可恢复、不牵连兄弟节点 |

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

建议每月跑一次（可选）：`MIKI_BENCH=1 npm run test` 会把 bench 组一起跑；日常 `npm test` 只跑常规用例。
测试表里 `workspace-io.spec.ts` 那条的内存对照是「只输出不断言」的，跑不跑都不影响绿灯。

默认跳过，不影响 `npm test`。perf.spec 输出各核心操作耗时表（导入 / 查询 / 答题 / 重放 / 批量删除 / 撤销）；minevents.spec 构造 100 万历史事件重启，断言 `events` 不驻留且 heapUsed 远低于事件总量（需 `--expose-gc` 排除 parse 垃圾干扰）。

百万卡参考值（2026-09-06，M 系列笔记本）：答题 0.12ms/次、撤销 0.3ms、批量删 1000 张 6.1ms、冷启动 5.3s、百万历史事件重启 heapUsed 22MB。

### 渲染层包体与懒加载

首帧只加载入口 chunk（React + markdown-it + KaTeX + 应用代码，约 0.96 MB raw / 230 kB gzip）。
三块重依赖走动态 import，各自独立 chunk，首帧不下载：

| 内容 | gzip 量级 | 何时加载 |
| --- | --- | --- |
| echarts | 约 500 kB | 切到统计页时 |
| Shiki 引擎（`shiki/core` + 正则引擎） | 约 80 kB | 首帧之后（`requestAnimationFrame` 预热） |
| 18 个语言包 | 合计约 300 kB | 引擎就绪后并行加载（每个语言一个 chunk） |

代码高亮因此不再挡在首帧前面：引擎就绪前的代码块先渲染成转义纯文本（`highlightSync`
返回 null 的既有语义），就绪后 `Md` 收到 `subscribeHighlighter` 通知重渲染一次补上 token 色。
改这块有两个容易踩的点：

- 语言包必须写成「键 → `() => import(...)`」的 thunk 表，不能写成「键 → 已 import 的模块」——
  后者在模块顶层就完成了静态 import，语言包照样进主 chunk，懒加载形同虚设。
- `Md` 用 `useMemo` 缓存渲染结果，依赖里必须带上引擎版本号（`useHighlighterVersion`），
  否则引擎就绪后不重渲染，代码块会永久停在纯文本。

**「答题落盘 < 50ms」那条已裁决为不必达标**（2026-09-10）：50k 卡实测 70.3ms，但那是
1000 次连续答题的**均值**，含每次的调度重算与队列维护；单次交互无感，用户裁决"已经足够好，
不用继续关注"。50k 卡同批实测：重放启动 141ms（需求 < 2s）、全量查询 87.7ms（需求 < 100ms）、
批量新增 5 万张 208ms、批量删 1000 张 8.4ms，均达标。**下次看到 70.3 > 50 请直接略过**。

有一条容易误判成性能问题、但复查后确认没问题的路径，记在这里免得反复怀疑：
`core/queue.ts` 的 `pickNext` 是 O(牌组卡数) 线性扫，但它只是测试对照 oracle，生产出卡走
`shared/schedule-index.ts` 的堆；`deckInfos()` 每次调用对未建堆的牌组做一次合并单趟扫描
（8 牌组 × 6000 卡约 4.8 万次迭代），属可调不可怕；卡片库的 60s 深滚动重取是有意保留的。

### NDJSON 行读

卡片基文件与 review-log 都会随使用无限增长，行读走 `iterateNdjson`（生成器）而不是
「`readFileSync().split('\n').filter(...)`」：旧的写法会同时持有整份文本与全部行的数组，
峰值约等于文件的 2 倍。三个调用点（卡片基文件 / delta / review-log）都是「解析一行、
丢掉一行」的流式消费，改成生成器后行不驻留，需要数组时用 `readNdjson`（薄封装）。

实测（2026-09-10，8.86MB 卡文件，独立 node 进程 + `--expose-gc`）：旧实现 16.56MB、
只读文本 14.77MB、流式 14.77MB——行数组的额外开销约等于文件大小的 19%。vitest 里量不准
（worker 进程与 GC 时机让 heapUsed 失真到 2 倍误差），所以内存对照不写成断言，只留这段记录。

语义差异只有一处：新实现把行两端空白 trim 掉（顺带挡掉 CRLF 的 `\r`）。全部调用方都是
`JSON.parse`，尾随空白本来就被忽略；`workspace-io.spec.ts` 里有与旧实现逐样本对拍。

## Android 移动端（mobile-android/）

同一份 `core/` 与 `shared/` 逻辑，套一层 Capacitor 壳跑在 Android 上：界面是 React（另一套
面向触屏的页面，不是桌面 UI 的响应式改造），数据层是**同一批纯函数**加一个 `FileStore`
抽象——桌面上是 node:fs，手机上走 Capacitor Filesystem 桥。

```bash
cd mobile-android
npm install
npm run dev          # 浏览器里开发（FileStore 用内存实现）
npm run build        # 产出 web 产物到 dist/
npx cap sync android # 同步到 android/ 工程
cd android && ./gradlew assembleDebug   # 产出 android/app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

提交前门禁（比桌面端多一步构建，因为要保证 Capacitor 能吃掉产物）：

```bash
npx tsc --noEmit && npx eslint . && npx vitest run && npm run build
```

移动端测试套件：

| 套件 | 内容 |
| --- | --- |
| `src/mobile/workspace.spec.ts` | 移动版数据层：**写路径（内存先行 → 追加落盘）与 reload（读文件 → 重放）必须互为逆运算**——这是跨机同步的正确性前提 |
| `src/mobile/study-session.spec.ts` | 学习会话状态机：出卡 → 显示答案 → 评级 → 下一张 → 撤销，含耗时报数口径 |
| `src/mobile/fs/memory-fs.spec.ts` | 内存 FileStore：与真机桥同语义的读写/追加/列目录/改名/删除 |
| `src/mobile/probes.spec.ts` | M0 探针逻辑在内存实现上的回归（真机跑法见设备「自检」页） |
| `src/mobile/theme.spec.ts` | 显示偏好纯逻辑（跟随系统 / 浅色 / 深色） |
| `src/mobile/sync/merge.spec.ts` | 合并判定与行并集：这是同步里唯一「错了会丢数据」的逻辑，含压实痕迹拦截与 JSON 整体文档拦截 |
| `src/mobile/sync/sync.spec.ts` | 同步编排集成测试（假 GitHub 实现 Git Data API）：拉取 → 合并 → 落地 → 重放校验 → 快照 → 推送 → 读回，含 fast-forward 冲突（422） |
| `src/mobile/sync/github.spec.ts` | GithubClient 请求细节：**所有请求必须显式禁掉 HTTP 缓存**（GitHub 响应带 `max-age=60`，WebView 会复用旧响应） |
| `src/mobile/sync/real-github.spec.ts` | 真服务器演练（默认跳过，需 `MIKI_GITHUB_TOKEN`/`MIKI_GITHUB_REPO`）：建**空分支起点**→ 推送 → 读回 → 拉取 → 双改 JSON 拦截 → 过期 head 422；分支名必须 `drill-` 开头，端点护栏拒 main/master |
| `src/mobile/real-workspace.spec.ts` | 真实工作区对账（默认跳过，需 `MIKI_REAL_WS`）：用只读 FileStore 指向真实工作区跑移动端加载器，与桌面端 `WorkspaceService` 的牌组计数逐项比对 |

两个真机才暴露得出来的坑，改同步相关代码前先看一眼（都已有回归测试钉住）：

- **同一天里的第二次加载必须强制重建调度索引**：`ensureDay()` 的语义是「跨天检测」，同日
  再调用会直接早退；而重载会把卡对象与卡桶整体换新，只调它就会留下过期的索引计数器
  （表现：同步拉取 / 回前台后，牌组列表的「新 / 总数」显示 0，而「待复习」因为走现场扫桶仍然正确）。
  桌面端 `reloadFromDisk()` 末尾有 `forceRebuild`，移动端 `loadAll()` 必须对齐。
- **网络层不能吃 HTTP 缓存**：GitHub 的 REST 响应带 `cache-control: private, max-age=60`，
  同一次同步里「推送前读的分支头」会被 WebView 的私有缓存复用，导致推送成功却报读回不一致；
  更危险的是合并判定也依赖「当前远端」的读取。Node 侧（undici）没有 HTTP 缓存，所以这个问题
  只有真机能测出来。

系统栏安全区（状态栏/挖孔、导航栏/手势条）另有一个只在特定组合上出现的坑，改布局或碰
Android 工程前务必先看：**`env(safe-area-inset-*)` 在 Android 上不是可靠来源**——
它只在「WebView ≥ 140 且页面带 `viewport-fit=cover`」时才有值，而 Capacitor 8 的 SystemBars
插件在不透传的那种组合里**只对 Android 15+**给 WebView 的父视图补内边距。于是
「Android 14 及以下 + 老 WebView」这一格两个机制都不生效，网页拿到的全是 0，内容就会压进
状态栏与三大金刚（Android 14 机器上实测就是这一格）。现在三处配合解决：

- `src/ui/styles.css` 的 `--inset-*` 取 `env()`、Capacitor 注入的 `--safe-area-inset-*`、
  以及 `MainActivity` 兜底注入的 `--native-inset-*` 三者最大值；
- `MainActivity.publishInsets()` 读真实窗口内边距并按上述变量发给网页，**已经被原生留过白的
  方向发 0**，所以取最大值不会叠加；排这类问题用 `adb logcat -s miki-insets`，日志里有
  「系统报了多少 / 原生补了多少 / 发给网页多少」三个数；
- `body` 用 `--inset-*` 留白，而 `.app` 的高度必须是容器的 `100%` 而不是 `100dvh`：
  后者比容器高出一个安全区，底部那一条会被 `overflow: hidden` 裁掉。固定的元素
  （评级条 / FAB / 提示条 / 抽屉内边距 / 弹层）按视口定位，不受 `body` padding 影响，各自
  还要用一次 `--inset-bottom`。

真机验证的取巧办法：模拟器上按目标机型配置（`cmd overlay enable
com.android.internal.systemui.navbar.threebutton` 开三大金刚、
`com.android.internal.display.cutout.emulation.tall` 模拟挖孔），再用 `chrome://inspect` 同款的
DevTools 协议直接量 `getBoundingClientRect()`。想验证「网页自己留白」那一格，可以在页面里
手动把 `--native-inset-*` 设成真值（模拟器多半落在「原生已补内边距」那格，光看界面看不出差别）。

图标不是手改的二进制：`mobile-android/scripts/gen_icons.py` 从桌面端的
`resources/icon.png` 抠出会标狐狸，派生自适应图标前景、传统方形/圆形图标、Android 13 主题图标
单色层与启动图 logo。换图标改桌面那张图后重跑脚本即可（`pip install pillow`）。

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
  - **不主动压实**：热加载不清 delta、不折叠他人刚同步的文件，只在内存中重建（压实阈值从零重新计数，与重启一致）。`pendingDeletes` 与 `deltaCounts` 一起归零是**有意**的——不因为本地攒了删除就去重写他人刚同步的文件；这个计数丢失不会造成永久滞留，因为下次启动的 `compactStaleDeletions` 直接读加载期快照（不依赖计数残留），会把积压补上。
