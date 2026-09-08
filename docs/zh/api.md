# Miki HTTP API

[English](../en/api.md) | 简体中文

Miki 在启动时内置一个**只监听本机回环地址**的 HTTP API，供人和 AI 程序化操作牌组与卡片（增删改查，含批量）。学习动作（答题/撤销）与配置写入不通过此接口暴露。

- 地址：`http://127.0.0.1:<port>/api`，端口默认 `8727`（被占用时依次顺延，实际端口见启动日志）
- 开关与端口：工作区 `config.json` 的 `api.enabled` / `api.port`，改后重启应用生效
- 认证 token：工作区 `config.json` 的 `api.token`（首次启动自动生成，长期不变）

```bash
TOKEN=$(python3 -c "import json;print(json.load(open('config.json'))['api']['token'])")
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8727/api/decks
```

## 安全边界

1. **只监听 127.0.0.1**，不对局域网/公网开放。
2. **Bearer token 必填**（`Authorization: Bearer <token>` 或 `X-Miki-Token: <token>`）；服务端用时序安全比较。`GET /api/health` 是唯一免 token 的端点，仅用于探活。
3. **带 `Origin` 或 `Referer` 的请求一律 403**——浏览器网页发起的跨站调用（CSRF）无法到达本接口；curl / 脚本 / AI 工具正常情况下不带这些头，不受影响。
4. **Host 校验**：只接受 `127.0.0.1:<port>` 与 `localhost:<port>`（端口跟随实际监听端口——配置端口被占用顺延后，以启动日志报出的实际端口为准），防 DNS rebinding。
5. **能力面收窄**：无答题、撤销、配置修改端点；写操作只覆盖牌组/卡片 CRUD。
6. 请求体上限 5 MB；非白名单方法 405；未知路径 404；错误统一为 `{"error": "..."}` 加对应状态码。

## 端点一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 探活（免 token） |
| GET | `/api/decks` | 牌组列表（counts：总数 total / 未学习 new / 到期 due，此刻口径） |
| POST | `/api/decks` | 建牌组：`{"name"}`；批量 `{"names": [...]}`
| PATCH | `/api/decks/:id` | 重命名 `{"name"}`
| DELETE | `/api/decks/:id` | 删牌组（其下卡片随之隐藏） |
| GET | `/api/cards` | 查询（参数见下） |
| GET | `/api/cards/:id` | 单张完整内容（含调度状态） |
| POST | `/api/cards/get` | 按 ID 批量取：`{"cardIds": [...]}`
| POST | `/api/cards/add` | 单张 `{"deckId", "front", "back"}`；批量 `{"deckId", "items": [{"front", "back"}, ...]}`
| PATCH | `/api/cards/:id` | 改单张内容 `{"front", "back"}`
| POST | `/api/cards/update` | 批量改：`{"items": [{"cardId", "front", "back"}, ...]}` → `{updated, missing}`
| POST | `/api/cards/move` | 批量移动：`{"cardIds", "deckId"}` → `{moved}`（保留调度进度）
| POST | `/api/cards/reset` | 批量重置进度：`{"cardIds"}` → `{reset}`（变回新卡，不可撤销）
| POST | `/api/cards/suspend` | 暂停/解除：`{"cardId", "suspended"}`
| POST | `/api/cards/delete` | 批量软删：`{"cardIds"}` → `{deleted, missing}`（可撤销）
| GET | `/api/stats?range=year\|all&deckId=` | 统计（预测/热力图/状态计数等） |

### GET /api/cards 查询参数

| 参数 | 说明 |
|---|---|
| `deckId` | 限定牌组；缺省 = 全部 |
| `q` | 关键词，逗号或空格分隔，多词 AND（匹配正面/反面） |
| `state` | `new` / `learning` / `review` / `suspended` |
| `dueAfter` / `dueBefore` | 到期时间窗（ms epoch）；无调度进度的卡不在窗口内 |
| `sort` | 如 `updatedAt:desc,front:asc`（列：front/deckName/state/due/dueAbs/interval/stability/difficulty/reps/lapses/createdAt/updatedAt） |
| `limit` / `offset` | 分页，默认 limit 5000 |

响应：`{"rows": [...], "total": 总数}`（`rows` 为卡片视图行，含状态、到期、稳定性等）。

## AI 使用提示

- **批量导入制卡**用 `POST /api/cards/add` 的 `items` 形式，一次几十张，服务端一次落盘。
- 批量端点对不存在的 ID 返回 `missing` 计数而不是整批失败，方便校对输入。
- 删除是软删、移动保留进度、重置不可撤销——AI 自动化时优先用前两者。
- MCP 接入：`node scripts/mcp-server.mjs`（环境变量 `MIKI_TOKEN`，可选 `MIKI_PORT`，默认 8727），在支持 MCP 的客户端里注册后即可获得 `list_decks` / `add_cards` / `search_cards` 等工具。
