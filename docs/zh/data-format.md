# 工作区数据格式

[English](../en/data-format.md) | 简体中文

Miki 的全部数据存放在一个纯文件夹（下称「工作区」）里，与代码和应用完全分离，可以用 git、网盘或任意同步工具管理。本文描述每个文件的格式与不变量，供备份、迁移或第三方程序读取。

工作区路径的解析顺序：环境变量 `MIKI_WORKSPACE` → `userData/workspace.json` 指针文件的 `current` → 首次启动引导（用户任选文件夹，默认建议 `~/miki-base`）。指针文件同时记录多工作区列表（`current` + `workspaces[]`），支持一人一个文件夹的多用户档案，旧版 `{workspacePath}` 格式自动升级。

```
<workspace>/
├── config.json                        # 应用配置（含 HTTP API 设置）
├── decks.json                         # 牌组列表
├── stats.json                         # 统计聚合检查点（热力图聚合 + 事件水位）
├── cards/<deck-id>.ndjson             # 卡片基文件（检查点快照行），追加 + 压实
├── cards/<deck-id>.delta.ndjson       # 卡片增量变更（内容覆盖 / 移入行 / 墓碑），只追加
└── review-log/<yyyy-mm>.ndjson        # 复习事件日志，只追加
```

## config.json

首次启动自动生成，应用写回（原子写：先写 `.tmp` 再改名）。主要字段：

| 字段 | 说明 |
| --- | --- |
| `theme` | `light`（默认）/ `dark` |
| `desiredRetention` | 目标留存率，默认 `0.9`，FSRS 由它推算间隔 |
| `parameters` | FSRS-6 的 21 个参数，默认值为官方训练模型 |
| `learningStepsSec` / `relearningStepsSec` | 学习/重学步长（秒），对齐 Anki 的 minutes 语义 |
| `maximumInterval` | 间隔上限天数，默认 36500 |
| `enableFuzzing` | 到期间隔随机抖动（Review 态），默认开 |
| `leechThreshold` | 累计「重来」达到该值自动暂停；`0` 关闭 |
| `study` | 刷卡字体 `fontFamily` / `fontSize` |
| `browser` | 卡片库记忆：`columns` 列顺序、`sort` 排序、列宽、选中项 |
| `api` | HTTP API：`enabled` / `port`（默认 8727）/ `token`（首启自动生成） |

## decks.json

```json
[
  { "id": "uuid", "name": "牌组名", "order": 0, "createdAt": 1757000000000, "deletedAt": null }
]
```

删除牌组是软删（`deletedAt` 置时间戳）：其下卡片文件不删除，但不再出现在任何视图与调度里。

## cards/&lt;deck-id&gt;.ndjson（基文件）

内容真理的检查点形式：首行是元数据行，其后每行一张卡的完整快照（内容 + 调度进度）：

```json
{"__mikiCheckpoint": 12345}
{ "id": "uuid", "front": "正面（Markdown）", "back": "反面（Markdown）", "createdAt": 1757000000000, "updatedAt": 1757000000000, "deletedAt": null, "suspended": false, "fsrs": {...}, "reps": 3, "lapses": 1 }
```

- `__mikiCheckpoint`：该文件快照已反映到的事件水位（全局 seq）。
- `fsrs` / `reps` / `lapses`：调度快照（state / step / stability / difficulty / due / lastReview + 计数），与事件重放结果一致。旧格式行没有这三个字段，视为零值并全量重放（兼容自动升级）。
- 新增卡直接追加到文件尾；delta 积累超过 **200 行**时自动「压实」：全量重写基文件 + 清空 delta。
- 删卡与跨牌组「移出」不写卡片文件（只写 review-log 与内存态），所以另有**待落盘计数**：
  累计 20 条删除/移出即自动压实该牌组，把内存态（含 `deletedAt`）写回基文件。没有这一步，
  只读卡片文件的程序会把已删除的卡当成还在（真实数据里曾差 59 张），而文件里没有任何线索
  指向 review-log。
- **压实保留软删行**（`deletedAt` 落成时间戳，行数不变）：卡片内容要留着供撤销与查看。

## cards/&lt;deck-id&gt;.delta.ndjson（增量）

内容变更的追加日志，**行序即操作时序**，每行三种之一：

```json
{ "id": "uuid", "front": "改后正面", "back": "...", "createdAt": ..., "updatedAt": ..., "deletedAt": null, "suspended": false }
{ "__mikiSeq": 12350, "id": "uuid", "front": "...", "...": "移入卡的完整快照行（含 fsrs/reps/lapses）" }
{ "id": "uuid", "__mikiTombstone": true }
```

- 内容覆盖行：只承载变化的内容字段，调度快照继承基行（缺哪个字段继承哪个）。
- 移入行（带 `__mikiSeq`）：跨牌组移动时写入目标牌组，自带完整调度快照与事件水位。
- 墓碑行：跨牌组移动时写入源牌组，加载时删除对应行。同一 delta 内「先墓碑后移入行」按行序自然恢复，往返移动不会误删。

### 只读消费者请注意：基文件不等于当前内容

只读 `cards/*.ndjson` 的「天真读者」会看到与应有一致性不符的结果，原因有三：

1. **软删卡仍在基文件里**：`deletedAt` 非空才是已删除，必须按该字段过滤，不能只数行数。
2. **删除未必已落盘**：删除只写 review-log，要等压实才写进基文件（见上面的待落盘计数）。
3. **跨牌组移动的目标侧只在 delta 里**：移入行写在目标牌的 `.delta.ndjson`，目标基文件要等压实
   才出现。

因此**权威口径请走 HTTP API**（`GET /api/decks` 的 `counts.total`、`GET /api/cards`），
或自行合并 `基文件 + delta（内容覆盖行 / 移入行 / 墓碑行）+ review-log 的事件`。
只读基文件得到的数字可能偏大。

## stats.json

统计聚合的检查点（压实时落盘，运行期不重写）：

```json
{ "checkpointSeq": 12345, "dailyAgg": [ ["<deck-id>", [ ["2026-09-06", { "total": 42, "again": 3 }], ... ]], ... ] }
```

热力图聚合按「牌组 → 本地日期键 → 当日总量/重来量」维护，`undo` 实时抵消。启动时 `seq > checkpointSeq` 的事件增量并入聚合，内存占用与事件历史总量无关。

## review-log/&lt;yyyy-mm&gt;.ndjson

**调度状态的唯一真理来源。** 事件只追加、永不改写，按月分文件（文件名序即时间序），每行一个事件：

```json
{ "seq": 42, "t": 1757000000000, "action": "answer", "cardId": "uuid", "deckId": "uuid", "rating": 3, "before": {...}, "after": {...}, "durationMs": 3500 }
```

- `seq`：全局递增序号，启动时按文件序 + 行序重编，事件间用它互相引用。
- `before` / `after`：操作前后的完整调度快照（state / step / stability / difficulty / due / lastReview），撤销不依赖重算历史。

### 事件类型

| action | 附加字段 | 语义 |
| --- | --- | --- |
| `answer` | `rating`(1-4)、`before`、`after`、`durationMs?` | 答题：FSRS 调度一次 |
| `delete` | `before` | 软删卡片，可撤销 |
| `undo` | `targetSeq`、`before`、`targetAction?`、`targetRating?` | 撤销：指向被抵消事件的 seq；`targetAction`/`targetRating` 是被抵消事件的类型与评分（自包含，旧事件由重放时的最近事件窗口兜底） |
| `reset` | `before` | 重置进度：调度与统计清零、解除暂停；**不可撤销** |
| `suspend` | `suspended`(缺省 true) | 暂停/解除暂停（含 leech 自动暂停）；**不可撤销**，改用暂停操作本身恢复 |

## 重放规则

启动时一次顺序读全部事件日志（`streamEvents`），**双水位消费**——同一事件流同时喂给卡片调度与统计聚合：

1. **卡片侧**：每张卡有自己的事件水位 `seqApplied`（来自快照行的 `__mikiSeq` / 基文件 `__mikiCheckpoint`）。`seq > seqApplied` 的事件才应用到卡，应用后水位前移。
2. **聚合侧**：`seq > stats.json.checkpointSeq` 的事件并入热力图聚合（`answer` +1，`undo` 对目标事件 -1）；今日净计数同步增量维护，跨天清零。

单事件应用规则（`src/core/replay.ts` 的 `applyEvent`，与全量重放共用同一实现）：

1. `answer`：`fsrs = after`，`reps + 1`；`rating = 1`（重来）时 `lapses + 1`。
2. `undo`：抵消 `targetSeq` 指向的事件——被撤销的是 answer 时 `reps/lapses` 回退并恢复 `before` 快照；是 delete 时取消软删。
3. `reset`：`fsrs / reps / lapses` 清零、解除暂停。
4. `delete`：置 `deletedAt`。
5. `suspend`：置 `suspended`（缺省 true）。

由此得到几条不变量：

- **任何内存态都可以由 `cards/*.ndjson`（含 delta）+ `review-log/*.ndjson` + `stats.json` 纯函数重建**，日志损坏行直接跳过而不影响其他数据；检查点文件缺失或过旧时自动退回全量重放。
- **历史事件不驻留内存**：启动重放是流式的，事件读入即用即弃；调度索引（due 最小堆 + 增量计数器）与统计聚合（DailyAgg）都是增量结构，内存与事件历史总量无关。
- **撤销是补偿事件，不是删除历史**——日志永远增长，撤销本身也被记录。
- **写路径与读取路径分离**：调度类操作（答题/撤销/删除/暂停/重置）只追加 review-log，零卡片文件写；内容类操作（新增/编辑/移动）追加基文件尾或 delta，写放大为 O(变更数)。

## 用第三方程序读取的注意事项

- 时间戳一律毫秒 epoch number；`due` 允许浮点（为 FSRS 小数天数预留）。
- 「天差」按 floor 语义计算（与 Python `timedelta.days` 一致）。
- 直接改 `cards/*.ndjson` 会被应用内存态覆盖——程序化读写请走 HTTP API（见 [api.md](api.md)），那是应用进程自己暴露的接口。
