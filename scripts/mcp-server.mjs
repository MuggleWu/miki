#!/usr/bin/env node
// Miki MCP 薄壳（stdio）：把本机 HTTP API 包装成 MCP 工具，供 AI 客户端直接操作牌组与卡片。
// 用法：node scripts/mcp-server.mjs
//   环境变量 MIKI_TOKEN（必填，见 miki 工作区 config.json 的 api.token）
//   环境变量 MIKI_PORT（可选，默认 8727）
// 所有工具只读转发到 http://127.0.0.1:<port>/api，安全边界与 HTTP API 相同（见 docs/api.md）。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const PORT = process.env.MIKI_PORT || '8727'
const TOKEN = process.env.MIKI_TOKEN
if (!TOKEN) {
  console.error('缺少环境变量 MIKI_TOKEN（miki 工作区 config.json 的 api.token）')
  process.exit(1)
}

const BASE = `http://127.0.0.1:${PORT}/api`

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`)
  return json
}

const server = new McpServer({ name: 'miki', version: '0.1.0' })

const deckId = z.string().describe('牌组 ID')
const cardIds = z.array(z.string()).describe('卡片 ID 列表')

server.tool('list_decks', '列出全部牌组及各状态卡片计数', {}, async () => ({
  content: [{ type: 'text', text: JSON.stringify(await call('GET', '/decks'), null, 2) }]
}))

server.tool(
  'create_decks',
  '创建牌组（单个或批量）',
  { names: z.array(z.string().min(1)).describe('牌组名称列表') },
  async ({ names }) => ({
    content: [{ type: 'text', text: JSON.stringify(await call('POST', '/decks', { names }), null, 2) }]
  })
)

server.tool('delete_deck', '删除牌组（其下卡片随之隐藏）', { deckId }, async ({ deckId }) => ({
  content: [{ type: 'text', text: JSON.stringify(await call('DELETE', `/decks/${deckId}`), null, 2) }]
}))

server.tool(
  'search_cards',
  '查询卡片：关键词/状态/到期窗口/分页',
  {
    deckId: z.string().optional().describe('限定牌组，缺省全部'),
    q: z.string().optional().describe('关键词，空格分隔多词 AND'),
    state: z.enum(['new', 'learning', 'review', 'suspended']).optional(),
    dueAfter: z.number().optional().describe('到期下限（ms epoch）'),
    dueBefore: z.number().optional().describe('到期上限（ms epoch）'),
    sort: z.string().optional().describe('如 updatedAt:desc,front:asc'),
    limit: z.number().optional(),
    offset: z.number().optional()
  },
  async (params) => {
    const usp = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined) usp.set(k, String(v))
    return { content: [{ type: 'text', text: JSON.stringify(await call('GET', `/cards?${usp}`), null, 2) }] }
  }
)

server.tool(
  'get_cards',
  '按 ID 批量取卡片完整内容（含调度状态）',
  { cardIds },
  async ({ cardIds }) => ({
    content: [{ type: 'text', text: JSON.stringify(await call('POST', '/cards/get', { cardIds }), null, 2) }]
  })
)

server.tool(
  'add_cards',
  '向指定牌组批量添加卡片（推荐制卡导入方式）',
  {
    deckId,
    items: z
      .array(z.object({ front: z.string(), back: z.string() }))
      .min(1)
      .describe('正反面内容列表')
  },
  async ({ deckId, items }) => ({
    content: [{ type: 'text', text: JSON.stringify(await call('POST', '/cards/add', { deckId, items }), null, 2) }]
  })
)

server.tool(
  'update_cards',
  '批量修改卡片正反面',
  { items: z.array(z.object({ cardId: z.string(), front: z.string(), back: z.string() })) },
  async ({ items }) => ({
    content: [{ type: 'text', text: JSON.stringify(await call('POST', '/cards/update', { items }), null, 2) }]
  })
)

server.tool('move_cards', '批量移动卡片到目标牌组（保留调度进度）', { cardIds, deckId }, async ({ cardIds, deckId }) => ({
  content: [{ type: 'text', text: JSON.stringify(await call('POST', '/cards/move', { cardIds, deckId }), null, 2) }]
}))

server.tool(
  'reset_progress',
  '批量重置卡片进度（变回新卡，不可撤销）',
  { cardIds },
  async ({ cardIds }) => ({
    content: [{ type: 'text', text: JSON.stringify(await call('POST', '/cards/reset', { cardIds }), null, 2) }]
  })
)

server.tool(
  'set_suspended',
  '暂停或解除暂停一张卡',
  { cardId: z.string(), suspended: z.boolean() },
  async ({ cardId, suspended }) => ({
    content: [{ type: 'text', text: JSON.stringify(await call('POST', '/cards/suspend', { cardId, suspended }), null, 2) }]
  })
)

server.tool('delete_cards', '批量软删卡片（可撤销）', { cardIds }, async ({ cardIds }) => ({
  content: [{ type: 'text', text: JSON.stringify(await call('POST', '/cards/delete', { cardIds }), null, 2) }]
}))

server.tool(
  'get_stats',
  '统计：到期预测/复习曲线/热力图/状态计数',
  { deckId: z.string().optional(), range: z.enum(['year', 'all']).optional() },
  async ({ deckId, range }) => {
    const usp = new URLSearchParams()
    if (deckId) usp.set('deckId', deckId)
    if (range) usp.set('range', range)
    return { content: [{ type: 'text', text: JSON.stringify(await call('GET', `/stats?${usp}`), null, 2) }] }
  }
)

await server.connect(new StdioServerTransport())
