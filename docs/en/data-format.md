# Workspace Data Format

English | [简体中文](../zh/data-format.md)

All of Miki's data lives in a single plain folder (the "workspace"), fully separate from the code and the app, manageable with git, cloud sync, or any other tool. This document describes each file's format and invariants, for backup, migration, or third-party readers.

Workspace path resolution order: the `MIKI_WORKSPACE` env var → the path recorded in `userData/workspace.json` → default `~/miki-base`.

```
<workspace>/
├── config.json                        # app config (includes HTTP API settings)
├── decks.json                         # deck list
├── stats.json                         # stats aggregation checkpoint (heatmap aggregates + event watermark)
├── cards/<deck-id>.ndjson             # card base file (checkpoint snapshot rows), append + compact
├── cards/<deck-id>.delta.ndjson       # card delta journal (content overrides / move-ins / tombstones), append-only
└── review-log/<yyyy-mm>.ndjson        # review event log, append-only
```

## config.json

Generated automatically on first launch and written back by the app (atomic write: `.tmp` first, then rename). Main fields:

| Field | Description |
| --- | --- |
| `theme` | `light` (default) / `dark` |
| `desiredRetention` | Target retention, default `0.9`; FSRS derives intervals from it |
| `parameters` | The 21 FSRS-6 parameters; defaults are from the official trained model |
| `learningStepsSec` / `relearningStepsSec` | Learning/relearning step lengths (seconds), matching Anki's minutes semantics |
| `maximumInterval` | Interval cap in days, default 36500 |
| `enableFuzzing` | Random due-date jitter (Review state), on by default |
| `leechThreshold` | Auto-suspend a card after this many cumulative lapses; `0` disables |
| `study` | Study font `fontFamily` / `fontSize` |
| `browser` | Browser state: `columns` order, `sort`, column widths, selection |
| `api` | HTTP API: `enabled` / `port` (default 8727) / `token` (generated on first launch) |

## decks.json

```json
[
  { "id": "uuid", "name": "deck name", "order": 0, "createdAt": 1757000000000, "deletedAt": null }
]
```

Deck deletion is a soft delete (`deletedAt` set to a timestamp): the deck's card file is kept, but it disappears from every view and from scheduling.

## cards/&lt;deck-id&gt;.ndjson (base file)

The checkpointed form of card truth: the first line is a metadata line, followed by one complete snapshot per card (content + scheduling progress):

```json
{"__mikiCheckpoint": 12345}
{ "id": "uuid", "front": "front (Markdown)", "back": "back (Markdown)", "createdAt": 1757000000000, "updatedAt": 1757000000000, "deletedAt": null, "suspended": false, "fsrs": {...}, "reps": 3, "lapses": 1 }
```

- `__mikiCheckpoint`: the event watermark (global seq) this file's snapshot reflects.
- `fsrs` / `reps` / `lapses`: scheduling snapshot (state / step / stability / difficulty / due / lastReview + counters), consistent with event replay. Legacy rows without these three fields are treated as zeros and fully replayed (auto-upgraded).
- New cards are appended to the file tail directly; when the delta grows past 2000 lines it is auto-"compacted": the base file is fully rewritten and the delta cleared.

## cards/&lt;deck-id&gt;.delta.ndjson (delta)

Append-only journal of content changes; **line order is operation order**. Each line is one of three kinds:

```json
{ "id": "uuid", "front": "edited front", "back": "...", "createdAt": ..., "updatedAt": ..., "deletedAt": null, "suspended": false }
{ "__mikiSeq": 12350, "id": "uuid", "front": "...", "...": "complete snapshot row of a moved-in card (with fsrs/reps/lapses)" }
{ "id": "uuid", "__mikiTombstone": true }
```

- Content override rows: carry only the changed content fields; scheduling snapshot fields are inherited from the base row (whichever fields are missing are inherited).
- Move-in rows (with `__mikiSeq`): written to the target deck on cross-deck moves, carrying a complete scheduling snapshot and event watermark.
- Tombstone rows: written to the source deck on cross-deck moves; removed from the corresponding base row at load time. Within one delta, "tombstone first, move-in later" resolves naturally by line order, so a move there and back never loses a card.

## stats.json

Checkpoint of the stats aggregation (written at compaction time, not rewritten during normal operation):

```json
{ "checkpointSeq": 12345, "dailyAgg": [ ["<deck-id>", [ ["2026-09-06", { "total": 42, "again": 3 }], ... ]], ... ] }
```

The heatmap aggregate is maintained per "deck → local date key → day total / day Again count", with `undo` compensating in real time. At startup, events with `seq > checkpointSeq` are merged into the aggregate incrementally; memory usage is independent of total event history.

## review-log/&lt;yyyy-mm&gt;.ndjson

**The single source of truth for scheduling state.** Events are append-only and never rewritten, split by month (filename order = time order), one event per line:

```json
{ "seq": 42, "t": 1757000000000, "action": "answer", "cardId": "uuid", "deckId": "uuid", "rating": 3, "before": {...}, "after": {...}, "durationMs": 3500 }
```

- `seq`: global incrementing sequence, renumbered at startup by file order + line order; events reference each other by it.
- `before` / `after`: complete scheduling snapshots before/after the operation (state / step / stability / difficulty / due / lastReview); undo never recomputes history.

### Event types

| action | Extra fields | Meaning |
| --- | --- | --- |
| `answer` | `rating`(1-4), `before`, `after`, `durationMs?` | Review: one FSRS scheduling step |
| `delete` | `before` | Soft-delete a card; undoable |
| `undo` | `targetSeq`, `before`, `targetAction?`, `targetRating?` | Undo: points at the seq of the event being compensated; `targetAction`/`targetRating` carry the target's type and rating (self-contained; legacy events fall back to the recent-event window at replay time) |
| `reset` | `before` | Reset progress: scheduling and stats cleared, suspension lifted; **irreversible** |
| `suspend` | `suspended` (default true) | Suspend / unsuspend (including leech auto-suspension); **irreversible** — reverse it with the suspend operation itself |

## Replay rules

At startup, the full event log is read sequentially once (`streamEvents`) with **dual-watermark consumption** — the same event stream feeds both card scheduling and stats aggregation:

1. **Card side**: each card has its own event watermark `seqApplied` (from the snapshot row's `__mikiSeq` / the base file's `__mikiCheckpoint`). Only events with `seq > seqApplied` are applied to the card; the watermark advances after each application.
2. **Aggregate side**: events with `seq > stats.json.checkpointSeq` are merged into the heatmap aggregate (`answer` +1, `undo` −1 on its target); today's net count is maintained incrementally and resets at midnight.

The single-event application rules (`applyEvent` in `src/core/replay.ts`, shared with full replay):

1. `answer`: `fsrs = after`, `reps + 1`; `rating = 1` (Again) also does `lapses + 1`.
2. `undo`: compensates the event at `targetSeq` — for an answer, `reps/lapses` roll back and the `before` snapshot is restored; for a delete, the soft delete is cancelled.
3. `reset`: `fsrs / reps / lapses` cleared, suspension lifted.
4. `delete`: sets `deletedAt`.
5. `suspend`: sets `suspended` (default true).

From this, several invariants follow:

- **Any in-memory state can be rebuilt as a pure function from `cards/*.ndjson` (incl. delta) + `review-log/*.ndjson` + `stats.json`**; corrupt log lines are skipped without affecting other data; missing or stale checkpoint files automatically fall back to full replay.
- **Historical events never stay in memory**: startup replay is streamed — events are used as they are read and discarded; the scheduling index (due min-heap + incremental counters) and stats aggregate (DailyAgg) are incremental structures, so memory is independent of total event history.
- **Undo is a compensating event, not a deletion of history** — the log only grows, and undo itself is recorded.
- **Write path and read path are separated**: scheduling operations (answer/undo/delete/suspend/reset) only append to review-log with zero card-file writes; content operations (add/edit/move) append to the base file tail or delta, with write amplification of O(changes).

## Notes for third-party readers

- Timestamps are always millisecond epoch numbers; `due` may be fractional (reserved for FSRS fractional days).
- "Day difference" uses floor semantics (matching Python's `timedelta.days`).
- Editing `cards/*.ndjson` directly will be overwritten by the app's in-memory state — for programmatic access use the HTTP API (see [api.md](api.md)), which is the interface exposed by the app process itself.
