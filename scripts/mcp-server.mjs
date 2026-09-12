#!/usr/bin/env node
// Miki MCP 薄壳（stdio）：把本机 HTTP API 包装成 MCP 工具，供 AI 客户端直接操作牌组与卡片。
// 用法：node scripts/mcp-server.mjs
// 连接方式（按优先级）：
//   1. 显式模式：环境变量 MIKI_TOKEN（+ 可选 MIKI_PORT）——旧行为，向后兼容
//   2. 自动发现（推荐，不设 MIKI_TOKEN）：
//      工作区 = MIKI_WORKSPACE 环境变量 → userData/workspace.json 的 current
//      token   = 该工作区私有文件 .miki/api-token
//      端口    = MIKI_PORT 环境变量 → userData/miki-api.json（实际监听端口，含顺延）→ config.json 的 api.port
//      userData 可用 MIKI_USER_DATA 覆盖（macOS ~/Library/Application Support/Miki / Windows %APPDATA%/Miki / Linux ~/.config/Miki）
// 自动发现使 MCP 始终跟随 miki 的当前工作区；切换工作区后重启 MCP 即可（或配 MIKI_WORKSPACE 指定档案）。
// 薄壳把本机 HTTP API 包装成 MCP 工具，供 AI 客户端直接操作牌组与卡片。
// 读工具（decks/cards/stats/openapi）只读转发；写工具（add/update/move/suspend/
// delete/reset）转发到同名 HTTP 写接口——安全边界与 HTTP API 相同：仅本机回环 +
// Bearer token，见 docs/en/api.md / docs/zh/api.md。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const VERSION = '0.2.0'

// ---------- 连接配置发现 ----------

function defaultUserData() {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'Miki')
    case 'win32':
      return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Miki')
    default:
      return path.join(os.homedir(), '.config', 'Miki')
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}

/** 进程存活探测：pid 不存在（ESRCH）视为过期文件；EPERM 等异常视为存活 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/** 端口文件身份校验：runtime 文件含 nonce，/api/health 回显同一 nonce 才可信。
 * pid 复用（强杀残留后被无关进程撞上同一 pid）时 kill(pid,0) 探不出真身，nonce 对不上即回退配置端口 */
async function nonceMatches(base, expected) {
  try {
    const c = new AbortController()
    const t = setTimeout(() => c.abort(), 800)
    const res = await fetch(`${base}/health`, { signal: c.signal })
    clearTimeout(t)
    const json = await res.json().catch(() => null)
    return !!json && json.nonce === expected
  } catch {
    return false
  }
}

async function resolveConnection() {
  // 1) 显式 token：旧行为，端口只认环境变量与默认值
  if (process.env.MIKI_TOKEN) {
    return {
      mode: 'explicit',
      base: `http://127.0.0.1:${process.env.MIKI_PORT || '8727'}/api`,
      workspace: null,
      token: process.env.MIKI_TOKEN
    }
  }
  // 2) 自动发现：跟随 miki 当前工作区
  const userData = process.env.MIKI_USER_DATA || defaultUserData()
  const pointer = readJson(path.join(userData, 'workspace.json'))
  const workspaceDir =
    process.env.MIKI_WORKSPACE || (pointer && typeof pointer.current === 'string' ? pointer.current : null)
  if (!workspaceDir) {
    console.error(
      `miki MCP：无法定位工作区（${userData}/workspace.json 缺失或无 current）。` +
        `请先在 miki 里完成首次启动引导，或设置 MIKI_WORKSPACE=<工作区目录> / MIKI_TOKEN=<token>。`
    )
    process.exit(1)
  }
  const cfg = readJson(path.join(workspaceDir, 'config.json'))
  // token 在工作区私有文件里（`.miki/api-token`，不随工作区仓库同步）；旧版本放在 config.json 的作为兜底
  let token = null
  try {
    token = fs.readFileSync(path.join(workspaceDir, '.miki', 'api-token'), 'utf-8').trim() || null
  } catch {
    token = null
  }
  if (!token && cfg && cfg.api && cfg.api.token) token = cfg.api.token
  if (!token) {
    console.error(
      `miki MCP：工作区 ${workspaceDir} 缺少 API token（首次启动 miki 后会自动生成到 .miki/api-token）。`
    )
    process.exit(1)
  }
  if (cfg.api.enabled === false) {
    console.error(
      `miki MCP：工作区 ${workspaceDir} 的 config.json 里 api.enabled=false，请在 miki 设置中开启 HTTP API 后重试。`
    )
    process.exit(1)
  }
  // 端口：显式 env > 运行时端口文件（pid 存活 + nonce 对上才采信）> 配置端口
  const runtime = readJson(path.join(userData, 'miki-api.json'))
  const cfgPort = cfg.api.port || 8727
  let port = cfgPort
  if (!process.env.MIKI_PORT && runtime && typeof runtime.port === 'number' && pidAlive(runtime.pid)) {
    const candidate = `http://127.0.0.1:${runtime.port}/api`
    const stale = runtime.nonce ? !(await nonceMatches(candidate, runtime.nonce)) : false
    if (!stale) port = runtime.port
  }
  return { mode: 'auto', base: `http://127.0.0.1:${port}/api`, workspace: workspaceDir, token }
}

const conn = await resolveConnection()
const TOKEN = conn.token
console.error(
  `miki MCP ${VERSION}：${conn.mode === 'auto' ? '自动发现' : '显式 token'} 模式 → ${conn.base}` +
    (conn.workspace ? `（工作区：${conn.workspace}）` : '')
)

// ---------- HTTP 转发 ----------

async function call(method, path, body) {
  const res = await fetch(`${conn.base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  })
  const json = await res.json().catch(() => ({}))
  if (res.status === 401) {
    throw new Error(
      '401 未授权：token 与当前工作区不匹配。若刚在 miki 里切换过工作区，重启本 MCP（自动发现会跟随当前工作区）；' +
        '或改用当前工作区 .miki/api-token 的值重新配置 MIKI_TOKEN。'
    )
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`)
  return json
}

// ---------- 工具 ----------

const server = new McpServer({ name: 'miki', version: VERSION })

const deckId = z.string().describe('牌组 ID')
// 批量上限：单次 500 张——防一次误传全库 id 打爆逐卡 HTTP；更大批次请分多次调用
const cardIds = z.array(z.string()).max(500).describe('卡片 ID 列表（单次最多 500）')

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
  'rename_deck',
  '重命名牌组',
  { deckId, name: z.string().min(1).describe('新名称') },
  async ({ deckId, name }) => ({
    content: [{ type: 'text', text: JSON.stringify(await call('PATCH', `/decks/${deckId}`, { name }), null, 2) }]
  })
)

/** 到期窗口参数：接受 ms 时间戳或日期字符串（YYYY-MM-DD 按本地时区，其他按 ISO 解析），降低传参出错率 */
function toEpochMs(v, name) {
  if (typeof v === 'number') return v
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  }
  const t = Date.parse(v)
  if (Number.isNaN(t)) throw new Error(`${name} 格式无法解析：请传 ms 时间戳或日期字符串（如 2026-09-30）`)
  return t
}

server.tool(
  'search_cards',
  '查询卡片：关键词/状态/到期窗口/分页（默认每页 50 条，total 提示是否需要翻页）',
  {
    deckId: z.string().optional().describe('限定牌组，缺省全部'),
    q: z.string().optional().describe('关键词，空格分隔多词 AND'),
    state: z.enum(['new', 'learning', 'review', 'suspended']).optional(),
    dueAfter: z.union([z.number(), z.string()]).optional().describe('到期下限：ms 时间戳或日期字符串（如 2026-09-30）'),
    dueBefore: z.union([z.number(), z.string()]).optional().describe('到期上限：ms 时间戳或日期字符串'),
    sort: z.string().optional().describe('如 updatedAt:desc,front:asc'),
    limit: z.number().int().positive().max(5000).optional().describe('默认 50'),
    offset: z.number().int().min(0).optional()
  },
  async (params) => {
    const usp = new URLSearchParams()
    if (params.dueAfter !== undefined) usp.set('dueAfter', String(toEpochMs(params.dueAfter, 'dueAfter')))
    if (params.dueBefore !== undefined) usp.set('dueBefore', String(toEpochMs(params.dueBefore, 'dueBefore')))
    for (const k of ['deckId', 'q', 'state', 'sort', 'offset']) {
      if (params[k] !== undefined) usp.set(k, String(params[k]))
    }
    usp.set('limit', String(params.limit ?? 50))
    return { content: [{ type: 'text', text: JSON.stringify(await call('GET', `/cards?${usp}`), null, 2) }] }
  }
)

server.tool('get_cards', '按 ID 批量取卡片完整内容（含调度状态）', { cardIds }, async ({ cardIds }) => ({
  content: [{ type: 'text', text: JSON.stringify(await call('POST', '/cards/get', { cardIds }), null, 2) }]
}))

server.tool(
  'add_cards',
  '向指定牌组批量添加卡片（推荐制卡导入方式；front 与 back 不能都为空）',
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
  '批量修改卡片正反面（部分更新：只传要改的一面，另一面保留原值）',
  {
    items: z.array(
      z
        .object({ cardId: z.string(), front: z.string().optional(), back: z.string().optional() })
        .refine((it) => it.front !== undefined || it.back !== undefined, {
          message: '每项至少提供 front 或 back 之一'
        })
    )
  },
  async ({ items }) => ({
    content: [{ type: 'text', text: JSON.stringify(await call('POST', '/cards/update', { items }), null, 2) }]
  })
)

server.tool(
  'move_cards',
  '批量移动卡片到目标牌组（保留调度进度）',
  { cardIds, deckId },
  async ({ cardIds, deckId }) => ({
    content: [{ type: 'text', text: JSON.stringify(await call('POST', '/cards/move', { cardIds, deckId }), null, 2) }]
  })
)

server.tool('reset_progress', '批量重置卡片进度（变回新卡，不可撤销）', { cardIds }, async ({ cardIds }) => ({
  content: [{ type: 'text', text: JSON.stringify(await call('POST', '/cards/reset', { cardIds }), null, 2) }]
}))

server.tool(
  'set_suspended',
  '批量暂停或解除暂停卡片',
  { cardIds, suspended: z.boolean() },
  async ({ cardIds, suspended }) => {
    // 并发逐卡请求，单项失败不中断其余；结果按卡汇报，计数只算真实成功的
    const settled = await Promise.allSettled(
      cardIds.map((cardId) => call('POST', '/cards/suspend', { cardId, suspended }).then(() => cardId))
    )
    const results = []
    let ok = 0
    settled.forEach((r, i) => {
      const cardId = cardIds[i]
      if (r.status === 'fulfilled') {
        ok++
        results.push({ cardId, ok: true })
      } else {
        results.push({ cardId, ok: false, error: r.reason instanceof Error ? r.reason.message : String(r.reason) })
      }
    })
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              succeeded: ok,
              failed: cardIds.length - ok,
              suspended: suspended ? ok : 0,
              unsuspended: suspended ? 0 : ok,
              cards: results
            },
            null,
            2
          )
        }
      ]
    }
  }
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

server.tool(
  'api_schema',
  '返回本机 HTTP API 的 OpenAPI 描述（了解全部端点后可直接经 MCP 之外的 HTTP 调用，需 token）',
  {},
  async () => ({
    content: [{ type: 'text', text: JSON.stringify(await call('GET', '/openapi.json'), null, 2) }]
  })
)

// ---------- 只读资源 ----------

server.registerResource('decks', 'miki://decks', { description: '全部牌组及各状态卡片计数（只读）' }, async () => ({
  contents: [{ uri: 'miki://decks', text: JSON.stringify(await call('GET', '/decks'), null, 2) }]
}))

server.registerResource(
  'stats',
  'miki://stats',
  { description: '近一年统计概要：到期预测/复习曲线/热力图/状态计数（只读）' },
  async () => ({
    contents: [{ uri: 'miki://stats', text: JSON.stringify(await call('GET', '/stats?range=year'), null, 2) }]
  })
)

// ---------- Prompt 模板 ----------

server.registerPrompt(
  'make-cards',
  {
    title: '制卡（最小知识原则）',
    description: '为主题生成符合最小知识原则的卡片清单，可直接交给 add_cards 导入',
    argsSchema: {
      topic: z.string().describe('制卡主题或要消化的材料要点'),
      deckId: z.string().optional().describe('目标牌组 ID；缺省时只生成清单不导入')
    }
  },
  async ({ topic, deckId }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            `请围绕「${topic}」生成记忆卡片，严格遵守最小知识原则：\n` +
            `1. 一张卡片只考一个知识点；复合知识必须拆成多张，宁可多卡。\n` +
            `2. 正面是一个明确、具体的问题（不带歧义，不出现"等等/如何..."式宽泛提问）；\n` +
            `   正面自带领域前缀（如"FSRS:"），刷卡时不看牌组也能知道背景。\n` +
            `3. 背面是短答，默认一句话，一行放得下；不写解释性长段。\n` +
            `4. 不做"总结卡/对比卡/大而全"卡片；不合并两个问题进一张卡。\n` +
            `5. 以 JSON 数组输出：[{"front": "...", "back": "..."}, ...]，不要输出其他解释。\n` +
            (deckId ? `6. 输出后立即调用 add_cards 工具导入牌组 ${deckId}。` : `6. 本轮只输出清单，不调用导入工具。`)
        }
      }
    ]
  })
)

await server.connect(new StdioServerTransport())
