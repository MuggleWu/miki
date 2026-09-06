# 工作区数据格式

Miki 的全部数据存放在一个纯文件夹（下称「工作区」）里，与代码和应用完全分离，可以用 git、网盘或任意同步工具管理。本文描述每个文件的格式与不变量，供备份、迁移或第三方程序读取。

工作区路径的解析顺序：环境变量 `MIKI_WORKSPACE` → `userData/workspace.json` 里记录的路径 → 默认 `~/miki-base`。

```
<workspace>/
├── config.json                  # 应用配置（含 HTTP API 设置）
├── decks.json                   # 牌组列表
├── cards/<deck-id>.ndjson       # 卡片内容，每行一个 JSON 对象
└── review-log/<yyyy-mm>.ndjson  # 复习事件日志，只追加
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

## cards/&lt;deck-id&gt;.ndjson

每行一个 `CardContent`，按 id 字符串排序存放，每次变更整文件原子重写：

```json
{ "id": "uuid", "front": "正面（Markdown）", "back": "反面（Markdown）", "createdAt": 1757000000000, "updatedAt": 1757000000000, "deletedAt": null, "suspended": false }
```

- `deletedAt`：软删标记；卡片可撤销恢复。
- `suspended`：暂停标记，可以是手动设置或 leech 自动暂停；暂停卡不进调度与计数。
- 卡片的调度状态（FSRS 稳定性/难度/到期）**不在这里**——它由 review-log 重放得出。

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
| `undo` | `targetSeq`、`before` | 撤销：指向被抵消事件的 seq |
| `reset` | `before` | 重置进度：调度与统计清零、解除暂停；**不可撤销** |

## 重放规则

启动时读全部事件日志并按卡分组重放（`src/core/replay.ts`），规则：

1. `answer`：`fsrs = after`，`reps + 1`；`rating = 1`（重来）时 `lapses + 1`。
2. `undo`：抵消 `targetSeq` 指向的事件——被撤销的是 answer 时 `reps/lapses` 回退并恢复 `before` 快照；是 delete 时取消软删。
3. `reset`：`fsrs / reps / lapses` 清零。
4. `delete`：置 `deletedAt`。

由此得到两条不变量：

- **任何内存态都可以由 `cards/*.ndjson` + `review-log/*.ndjson` 纯函数重建**，因此日志损坏行直接跳过而不影响其他数据。
- **撤销是补偿事件，不是删除历史**——日志永远增长，撤销本身也被记录。

## 用第三方程序读取的注意事项

- 时间戳一律毫秒 epoch number；`due` 允许浮点（为 FSRS 小数天数预留）。
- 「天差」按 floor 语义计算（与 Python `timedelta.days` 一致）。
- 直接改 `cards/*.ndjson` 会被应用内存态覆盖——程序化读写请走 HTTP API（见 [api.md](api.md)），那是应用进程自己暴露的接口。
