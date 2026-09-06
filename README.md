# miki

A local-first spaced repetition app — an Anki alternative with FSRS-6 scheduling, built with Electron + React.

本地优先的记忆卡片应用（Anki 替代品）：FSRS-6 调度、事件溯源复习日志、纯文件工作区。

## Features

- **FSRS-6 scheduling** — ported from py-fsrs v6.3.2, verified against 44 generated conformance vectors
- **Four views** — decks, study (space-to-reveal, 4-button rating), card browser (multi-keyword AND search, configurable columns, rotate sort), stats (forecast / heatmap / reviews / card states / intervals)
- **Rich card content** — Markdown + KaTeX + syntax highlighting
- **Event-sourced review log** — append-only NDJSON; undo works by compensating events with self-contained snapshots
- **Plain-file workspace** — data lives in a folder separate from the app, git-friendly, sync with any tool
- **Light / dark themes** — light by default
- **Unlimited daily review** — learning queue first, then due reviews, then new cards

## Development

```bash
npm install
npm run dev      # dev mode
npm run build    # production build
npm test         # FSRS vector conformance + core regression tests
npm start        # run the built app
```

## Workspace format

Data is stored in a plain folder (resolved from the `MIKI_WORKSPACE` env var, falling back to `~/miki-base`):

```
config.json                     # app config (FSRS parameters, theme, browser layout)
decks.json                      # deck list
cards/<deck-id>.ndjson          # card content, one JSON object per line
review-log/<yyyy-mm>.ndjson     # append-only review events (answer / delete / undo)
```

`review-log` is the source of truth for scheduling; card states are rebuilt by replaying events.

## License

[MIT](LICENSE)
