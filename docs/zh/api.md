# Miki HTTP API

[English](../en/api.md) | 简体中文

Miki 在启动时内置一个**只监听本机回环地址**的 HTTP API，供人和 AI 程序化操作牌组与卡片（增删改查，含批量）。学习动作（答题/撤销）与配置写入不通过此接口暴露。

- 地址：`http://127.0.0.1:<port>/api`，端口默认 `8727`（被占用时依次顺延，实际端口见启动日志，同时写入 `userData/miki-api.json` 运行时文件，含 `port`、`pid` 与 `nonce`——nonce 与 `/api/health` 回显值一致，外部工具用于甄别强杀残留的过期文件）
- 开关与端口：工作区 `config.json` 的 `api.enabled` / `api.port`，改后重启应用生效
- 认证 token：工作区私有文件 `.miki/api-token`（首次启动自动生成，长期不变；该目录已被 `.gitignore` 排除，不随工作区仓库同步）

```bash
TOKEN=$(cat .miki/api-token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8727/api/decks
```

## 安全边界

1. **只监听 127.0.0.1**，不对局域网/公网开放。
2. **Bearer token 必填**（`Authorization: Bearer <token>` 或 `X-Miki-Token: <token>`）；服务端用时序安全比较。`GET /api/health` 与 `GET /api/openapi.json` 免 token（无敏感信息，用于探活与接口自发现）。
3. **带 `Origin` 或 `Referer` 的请求一律 403**——浏览器网页发起的跨站调用（CSRF）无法到达本接口；curl / 脚本 / AI 工具正常情况下不带这些头，不受影响。
4. **Host 校验**：只接受 `127.0.0.1:<port>` 与 `localhost:<port>`（端口跟随实际监听端口——配置端口被占用顺延后，以启动日志报出的实际端口为准），防 DNS rebinding。
5. **能力面收窄**：无答题、撤销、配置修改端点；写操作只覆盖牌组/卡片 CRUD。
6. 请求体上限 5 MB；非白名单方法 405；未知路径 404；错误统一为 `{"error": "..."}` 加对应状态码。
7. **HEAD 镜像 GET 语义**：同一套鉴权 + 同一路由匹配 + handler 执行（GET 全只读），状态码逐一对齐（未知卡 404、非法参数 400 如实返回），响应体由 HTTP 层省略。
8. **切换工作区期间返回 503**：确认切换后立刻排空本进程的写入口（停监听 + 停止文件监视），已建立的连接复用即被重置，新连接被拒；切换窗口内仍在处理的那一个请求返回 `503 {"error":"工作区正在切换，...请稍后重试"}`。目的是让外部工具（MCP / 脚本）**不会把写操作落到旧工作区**。调用方把 503 与连接错误都当作「稍后重试」即可，进程随即重启到新工作区。

## 端点一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 探活（免 token） |
| GET | `/api/openapi.json` | OpenAPI 3.1 接口自描述（免 token，供 AI agent 免读文档自发现） |
| GET | `/api/decks` | 牌组列表（counts：总数 total / 未学习 new / 到期 due，此刻口径） |
| POST | `/api/decks` | 建牌组：`{"name"}`；批量 `{"names": [...]}`
| PATCH | `/api/decks/:id` | 重命名 `{"name"}`
| DELETE | `/api/decks/:id` | 删牌组（其下卡片随之隐藏） |
| GET | `/api/cards` | 查询（参数见下） |
| GET | `/api/cards/:id` | 单张完整内容（含调度状态） |
| POST | `/api/cards/get` | 按 ID 批量取：`{"cardIds": [...]}` |
| POST | `/api/cards/add` | 单张 `{"deckId", "front", "back"}`（正反不能都为空，与 UI 同口径；允许仅背面卡）；批量 `{"deckId", "items": [{"front", "back"}, ...]}`（每项至少一个内容字段） |
| PATCH | `/api/cards/:id` | 改单张内容 `{"front", "back"}`——至少给一个字段，未给的字段保留原值 |
| POST | `/api/cards/update` | 批量改：`{"items": [{"cardId", "front", "back"}, ...]}`（每项至少一个内容字段，未给的字段保留原值）→ `{updated, missing}` |
| POST | `/api/cards/move` | 批量移动：`{"cardIds", "deckId"}` → `{moved}`（保留调度进度）
| POST | `/api/cards/reset` | 批量重置进度：`{"cardIds"}` → `{reset}`（变回新卡，不可撤销）
| POST | `/api/cards/suspend` | 暂停/解除：`{"cardId", "suspended"}`——`suspended` 必须是严格布尔（传 `"false"` 等非布尔值返回 400，不做真值强转） |
| POST | `/api/cards/delete` | 批量软删：`{"cardIds"}` → `{deleted, missing}`（可撤销） |
| GET | `/api/stats?range=year\|all&deckId=` | 统计（预测/热力图/状态计数等） |

### GET /api/cards 查询参数

| 参数 | 说明 |
|---|---|
| `deckId` | 限定牌组；缺省 = 全部 |
| `q` | 关键词，逗号或空格分隔，多词 AND（匹配正面/反面） |
| `state` | `new` / `learning` / `review` / `suspended` |
| `dueAfter` / `dueBefore` | 到期时间窗：ms 时间戳或日期字符串（`YYYY-MM-DD` 按**本地零点**解析，与 MCP 口径一致；含时间的 ISO 串按其自身时区）；无调度进度的卡不在窗口内 |
| `sort` | 如 `updatedAt:desc,front:asc`（列必须来自白名单：front/deckName/state/due/dueAbs/interval/stability/difficulty/reps/lapses/createdAt/updatedAt，非法列 400） |
| `limit` / `offset` | 分页，默认 limit 5000；负值 clamp 到 0 |

响应：`{"rows": [...], "total": 总数}`（`rows` 为卡片视图行，含状态、到期、稳定性等）。

## AI 使用提示

- **批量导入制卡**用 `POST /api/cards/add` 的 `items` 形式，一次几十张，服务端一次落盘。
- 批量端点对不存在的 ID 返回 `missing` 计数而不是整批失败，方便校对输入。
- 删除是软删、移动保留进度、重置不可撤销——AI 自动化时优先用前两者。
- MCP 接入：`node scripts/mcp-server.mjs`。推荐**自动发现**：不设 `MIKI_TOKEN` 时，wrapper 自动定位当前工作区（`MIKI_WORKSPACE` → `userData/workspace.json` 的 `current`）并读取其 `.miki/api-token` 拿 token，端口优先读 `userData/miki-api.json` 运行时文件（pid 存活且 nonce 对上才采用，防强杀残留的过期文件）——切换工作区后重启 MCP 即可跟随。也可显式指定 `MIKI_TOKEN`（可选 `MIKI_PORT`）保持旧行为。工具含 `list_decks` / `add_cards` / `search_cards`（默认每页 50，日期参数接受 `YYYY-MM-DD`，按本地零点解析）/ `update_cards`（部分更新）/ `rename_deck` / `set_suspended`（批量）/ `api_schema` 等；批量工具单次最多 500 张卡。另提供只读资源 `miki://decks`、`miki://stats` 与制卡 prompt 模板 `make-cards`（最小知识原则）。
