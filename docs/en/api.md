# Miki HTTP API

English | [简体中文](../zh/api.md)

At startup Miki runs an HTTP API **bound to the local loopback only**, for humans and AI agents to manage decks and cards programmatically (CRUD, including batch operations). Study actions (answering / undo) and config writes are not exposed through this interface.

- Address: `http://127.0.0.1:<port>/api`; the port defaults to `8727` (incrementing if taken; the actual port appears in the startup log and is written to the `userData/miki-api.json` runtime file with `port`, `pid` and `nonce` — the nonce matches the value echoed by `/api/health`, so external tools can tell stale files left behind by killed processes)
- Switch & port: workspace `config.json` fields `api.enabled` / `api.port`; restart the app to apply changes
- Auth token: workspace `config.json` field `api.token` (generated automatically on first launch, long-lived)

```bash
TOKEN=$(python3 -c "import json;print(json.load(open('config.json'))['api']['token'])")
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8727/api/decks
```

## Security boundary

1. **Listens on 127.0.0.1 only** — never exposed to the LAN or the internet.
2. **Bearer token required** (`Authorization: Bearer <token>` or `X-Miki-Token: <token>`); compared with a timing-safe comparison. `GET /api/health` and `GET /api/openapi.json` are token-free (no sensitive data — liveness probe and schema self-discovery).
3. **Requests carrying `Origin` or `Referer` are always 403** — cross-site calls launched from browser pages (CSRF) cannot reach the interface; curl / scripts / AI tools normally omit these headers and are unaffected.
4. **Host check**: only `127.0.0.1:<port>` and `localhost:<port>` are accepted (the port follows the actual listening port — if the configured port is taken it increments, and the startup log reports the actual one), preventing DNS rebinding.
5. **Narrow capability surface**: no answer, undo, or config endpoints; write operations cover deck/card CRUD only.
6. Request bodies are capped at 5 MB; non-whitelisted methods get 405; unknown paths get 404; errors are uniformly `{"error": "..."}` with the corresponding status code.
7. **HEAD mirrors GET semantics**: same auth + same route matching + handler execution (GET is read-only throughout), status codes aligned one by one (unknown card 404, invalid params 400 are reported as-is), with the response body omitted by the HTTP layer.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Liveness (no token) |
| GET | `/api/openapi.json` | OpenAPI 3.1 self-description (no token; lets AI agents discover endpoints without reading docs) |
| GET | `/api/decks` | Deck list (counts: total / new / due-now) |
| POST | `/api/decks` | Create a deck: `{"name"}`; batch: `{"names": [...]}` |
| PATCH | `/api/decks/:id` | Rename `{"name"}` |
| DELETE | `/api/decks/:id` | Delete a deck (its cards are hidden with it) |
| GET | `/api/cards` | Query (parameters below) |
| GET | `/api/cards/:id` | Single card with full content (incl. scheduling state) |
| POST | `/api/cards/get` | Batch fetch by ID: `{"cardIds": [...]}` |
| POST | `/api/cards/add` | Single: `{"deckId", "front", "back"}`; batch: `{"deckId", "items": [...]}`; front and back must not both be empty (same rule as the UI; back-only cards are allowed) |
| PATCH | `/api/cards/:id` | Partial update: `{"front", "back"}`, at least one field; omitted fields keep their value |
| POST | `/api/cards/update` | Batch partial update: `{"items": [{"cardId", "front"?, "back"?}, ...]}` (each item needs at least one content field) → `{updated, missing}` |
| POST | `/api/cards/move` | Batch move: `{"cardIds", "deckId"}` → `{moved}` (scheduling progress kept) |
| POST | `/api/cards/reset` | Batch reset progress: `{"cardIds"}` → `{reset}` (back to new, irreversible) |
| POST | `/api/cards/suspend` | Suspend/unsuspend: `{"cardId", "suspended"}` — `suspended` must be a strict boolean (non-boolean values like `"false"` return 400; no truthiness coercion) |
| POST | `/api/cards/delete` | Batch soft-delete: `{"cardIds"}` → `{deleted, missing}` (undoable) |
| GET | `/api/stats?range=year\|all&deckId=` | Stats (forecast / heatmap / state counts etc.) |

### GET /api/cards query parameters

| Parameter | Description |
|---|---|
| `deckId` | Restrict to a deck; omit for all |
| `q` | Keywords, comma- or space-separated, multi-word AND (matches front/back) |
| `state` | `new` / `learning` / `review` / `suspended` |
| `dueAfter` / `dueBefore` | Due-time window: ms epoch or a date string (`YYYY-MM-DD` is parsed at **local midnight**, consistent with the MCP; date-time ISO strings use their own timezone); cards without scheduling progress are never in the window |
| `sort` | e.g. `updatedAt:desc,front:asc` (fields are whitelisted: front/deckName/state/due/dueAbs/interval/stability/difficulty/reps/lapses/createdAt/updatedAt; unknown field → 400) |
| `limit` / `offset` | Pagination, default limit 5000; negative values are clamped to 0 |

Response: `{"rows": [...], "total": <count>}` (`rows` are card view rows with state, due, stability, etc.).

## Tips for AI agents

- For **bulk card import** use the `items` form of `POST /api/cards/add` — dozens per call, persisted server-side in one pass.
- Batch endpoints report `missing` counts for nonexistent IDs instead of failing the whole batch, which makes input validation easy.
- Delete is soft, move keeps progress, reset is irreversible — for automation prefer them in that order.
- MCP integration: `node scripts/mcp-server.mjs`. **Auto-discovery is recommended**: with no `MIKI_TOKEN`, the wrapper locates the current workspace (`MIKI_WORKSPACE` env → `current` in `userData/workspace.json`) and reads its `config.json` for the token; the port prefers the `userData/miki-api.json` runtime file (adopted only when the pid is alive and the nonce matches, guarding against stale files from killed processes) — after switching workspaces, just restart the MCP to follow along. Explicit `MIKI_TOKEN` (+ optional `MIKI_PORT`) keeps the legacy behavior. Tools include `list_decks` / `add_cards` / `search_cards` (default page size 50; date params accept `YYYY-MM-DD`, parsed at local midnight) / `update_cards` (partial update) / `rename_deck` / `set_suspended` (batch) / `api_schema`; batch tools accept up to 500 card IDs per call. Plus read-only resources `miki://decks`, `miki://stats` and the `make-cards` prompt template (minimum-information principle).
