# miki

English | [简体中文](README-zh.md)

A local-first spaced repetition app — an Anki alternative with FSRS-6 scheduling, built with Electron + React.

本地优先的记忆卡片应用（Anki 替代品）：FSRS-6 调度、事件溯源复习日志、纯文件工作区。

## Features

- **FSRS-6 scheduling** — ported from py-fsrs v6.3.2, verified against 44 generated conformance vectors; every rating button previews the next due date before you commit
- **Five views** — decks (table sorted by name), study, card browser, stats (forecast / heatmap / reviews / card states / intervals), and settings
- **Leech handling** — a card that reaches the lapse threshold is auto-suspended: it leaves the queue and all counts, shows as ⏸ in the browser, and can be unsuspended with one click
- **Card browser** — multi-keyword AND search, configurable columns with drag-resizable widths and rotate sort, resizable side/panel dividers, inline editor with live Markdown preview; due shown in two columns — relative ("5 分钟后") and absolute ("2026-09-06 16:49")
- **Study fonts** — configurable typeface and size for the card face, with a live sample in Settings; defaults follow the system font at 16px, matching Obsidian
- **Rich card content** — Markdown + KaTeX + syntax highlighting
- **Event-sourced review log** — append-only NDJSON; undo works by compensating events with self-contained snapshots
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

## Workspace format

Data is stored in a plain folder (resolved from the `MIKI_WORKSPACE` env var, falling back to `~/miki-base`):

```
config.json                     # app config (FSRS parameters, theme, study fonts, leech threshold, browser & home layout)
decks.json                      # deck list
cards/<deck-id>.ndjson          # card content, one JSON object per line (includes the suspended flag)
review-log/<yyyy-mm>.ndjson     # append-only review events (answer / delete / undo)
```

`review-log` is the source of truth for scheduling; card states are rebuilt by replaying events.

## License

[MIT](LICENSE)
