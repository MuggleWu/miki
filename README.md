# miki

English | [简体中文](README-zh.md)

A local-first spaced repetition app — an Anki alternative with FSRS-6 scheduling, built with Electron + React.

本地优先的记忆卡片应用（Anki 替代品）：FSRS-6 调度、事件溯源复习日志、纯文件工作区。

## Why Miki

Anki is a truly fine piece of software that has helped many people, and FSRS is a genuinely great algorithm for keeping due dates under control. But as an individual, what I want is the minimal feature set that fits me — not everything. So I tailored and trimmed a version of my own, and that is Miki.

It is a very small open-source project. Perhaps by the time I grow old, no one in this world will ever have found it. But it exists — and it is proof that we were here.

## Features

- **FSRS-6 scheduling** — ported from py-fsrs v6.3.2, verified against 550+ generated conformance vectors; every rating button previews the next due date before you commit
- **Five views** — decks (table sorted by name), study, card browser, stats (forecast / heatmap / reviews / card states / intervals), and settings
- **Leech handling** — a card that reaches the lapse threshold is auto-suspended: it leaves the queue and all counts, shows as ⏸ in the browser, and can be unsuspended with one click
- **Card browser** — multi-keyword AND search, configurable columns with drag-resizable widths and rotate sort, resizable side/panel dividers, inline editor with live Markdown preview, and virtual scrolling that stays smooth with tens of thousands of cards; due shown in two columns — relative ("5 分钟后") and absolute ("2026-09-06 16:49")
- **Study fonts** — configurable typeface and size for the card face, with a live sample in Settings; defaults follow the system font at 16px, matching Obsidian
- **Rich card content** — Markdown + KaTeX + syntax highlighting
- **Event-sourced review log** — append-only NDJSON; undo works by compensating events with self-contained snapshots
- **Million-card performance** — extreme-scale engineering on top of the event-sourced core: historical events are streamed and never retained in memory (a restart over 1M past events settles at 22MB), scheduling is served by incremental indexes (0.12ms per answer, 0.3ms per undo), and card files use checkpoints + delta appends (undo write amplification drops from a full-file rewrite to a single append; cold start 5.3s); randomized differential tests keep index semantics strictly identical to a full scan
- **Plain-file workspace** — data lives in a folder separate from the app, git-friendly, sync with any tool
- **Light / dark themes** — light by default
- **Unlimited daily review** — learning queue first, then due reviews, then new cards

## Keyboard shortcuts

Single-key shortcuts are identical on all platforms. Wherever the app or this README shows `⌘` (Cmd), Windows and Linux users can press `Ctrl` instead — e.g. `⌘F` becomes `Ctrl+F`.

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Reveal answer / rate Good | `Space` | `Space` |
| Rate Again / Hard / Good / Easy | `1` `2` `3` `4` | `1` `2` `3` `4` |
| Study / Browser / Stats / Home | `S` `B` `T` `D` | `S` `B` `T` `D` |
| Add card / Edit current card | `A` `E` | `A` `E` |
| Delete current card | `⌘D` | `Ctrl+D` |
| Undo last answer / delete | `⌘Z` | `Ctrl+Z` |
| Focus browser search | `⌘F` | `Ctrl+F` |
| Confirm add/edit dialog | `⌘Enter` | `Ctrl+Enter` |
| Close dialog | `Esc` | `Esc` |

Single-key shortcuts are ignored while typing in a text field, so `Ctrl+C/V` etc. keep working inside inputs.

## Development

```bash
npm install
npm run dev        # dev mode
npm run build      # production build
npm run typecheck  # strict TypeScript, no emit
npm test           # FSRS vector conformance + core regression tests
npm start          # run the built app
```

Runs on macOS, Windows and Linux (standard Electron window, no platform-specific APIs). Binary packaging/installers are planned; for now run from source.

## HTTP API & MCP

Miki ships a local HTTP API for humans and AI agents to manage decks and cards programmatically (CRUD, including batch operations). It listens on `127.0.0.1:8727` only, requires a bearer token, and rejects browser-originated cross-site requests. See [docs/api.md](docs/api.md).

For MCP clients, a thin stdio wrapper is included:

```bash
MIKI_TOKEN=<token from config.json> node scripts/mcp-server.mjs
```

It exposes tools such as `list_decks`, `add_cards`, `search_cards`, `update_cards`, `move_cards`, `delete_cards`, `reset_progress` and `get_stats`.

## Documentation

More docs (in Chinese) live in [docs/](docs/):

- [使用手册](docs/usage.md) — views, interactions and the full shortcut list
- [工作区数据格式](docs/data-format.md) — file layouts, event schema and replay rules
- [HTTP API](docs/api.md) — endpoints, auth and safety boundaries
- [开发指南](docs/development.md) — project structure, tests and the FSRS vector harness

## Workspace format

Data is stored in a plain folder (resolved from the `MIKI_WORKSPACE` env var, falling back to `~/miki-base`):

```
config.json                       # app config (FSRS parameters, theme, study fonts, leech threshold, browser & home layout)
decks.json                        # deck list
stats.json                        # stats aggregation checkpoint (daily aggregates + event watermark)
cards/<deck-id>.ndjson            # card base file (checkpoint snapshot rows, includes the suspended flag)
cards/<deck-id>.delta.ndjson      # card delta journal (edits / moves / tombstones), append-only
review-log/<yyyy-mm>.ndjson       # append-only review events (answer / delete / undo / reset / suspend)
```

`review-log` is the source of truth for scheduling; the card base file + delta form a checkpointed record of card truth, aligned to the event watermark. See [docs/data-format.md](docs/data-format.md) for the full schema, compaction rules and replay protocol.

## Acknowledgements

This work is dedicated to my wife, Meihua.

- [Anki](https://apps.ankiweb.net/) — the gold standard that made spaced repetition mainstream, and the reason Miki exists
- [FSRS](https://github.com/open-spaced-repetition/fsrs4anki) and [py-fsrs](https://github.com/open-spaced-repetition/py-fsrs) — the open-source scheduling algorithm and its reference implementation, from which Miki's scheduler is ported and verified
- The open-source stack Miki stands on: Electron, React, Vite, ECharts, markdown-it, KaTeX, highlight.js

## License

[MIT](LICENSE)
