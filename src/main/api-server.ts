// 本机 HTTP API：把工作区 CRUD 能力暴露给人与 AI（技术栈 §2 的延伸，见 docs/api.md）
// 安全边界：
//   1. 只监听 127.0.0.1，不对局域网开放
//   2. Host 校验（防 DNS rebinding）、Origin/Referer 一律拒绝（防浏览器跨站请求）
//   3. 除 /api/health 外必须携带 Bearer token（workspace 首次启动生成，config.json 查看）
//   4. 不暴露 answer/undo/配置写等学习与设置动作，只开放牌组与卡片 CRUD + 统计
import * as http from 'node:http'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { timingSafeEqual, createHash } from 'node:crypto'
import type { WorkspaceService } from './workspace'
import type { QueryParams, SortKey } from '../shared/types'
import type { BrowserColumn } from '../shared/types'
import { openApiDoc } from './api-openapi'
import { atomicWrite } from './atomic-write'

const MAX_BODY_BYTES = 5 * 1024 * 1024

/** sort 列白名单：与卡片库 BrowserColumn 一致，挡住拼写错误导致的静默排序失效 */
const SORT_COLUMNS: readonly BrowserColumn[] = [
  'front', 'deckName', 'state', 'due', 'dueAbs', 'interval',
  'stability', 'difficulty', 'reps', 'lapses', 'createdAt', 'updatedAt'
]

class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

interface Ctx {
  params: Record<string, string>
  query: URLSearchParams
  body: unknown
}

type Handler = (ctx: Ctx) => unknown

/** 路由表：method + '/api/...' 路径（:段 为路径参数），按注册顺序匹配 */
function buildRoutes(ws: WorkspaceService): [string, string, Handler][] {
  const routes: [string, string, Handler][] = []

  routes.push(['GET', '/api/health', () => ({ ok: true, name: 'miki' })])
  routes.push(['GET', '/api/openapi.json', () => openApiDoc])

  // ---------- 牌组 ----------
  routes.push(['GET', '/api/decks', () => ({ decks: ws.deckInfos() })])
  routes.push(['POST', '/api/decks', ({ body }) => {
    const b = body as { name?: unknown; names?: unknown }
    if (Array.isArray(b.names)) {
      const names = b.names.map(String).map((s) => s.trim()).filter(Boolean)
      if (names.length === 0) throw new ApiError(400, 'names 不能为空')
      return { decks: names.map((n) => ws.addDeck(n)) }
    }
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (!name) throw new ApiError(400, 'name 不能为空')
    return ws.addDeck(name)
  }])
  routes.push(['PATCH', '/api/decks/:id', ({ params, body }) => {
    const name = typeof (body as { name?: unknown }).name === 'string' ? (body as { name: string }).name.trim() : ''
    if (!name) throw new ApiError(400, 'name 不能为空')
    const deck = ws.renameDeck(params.id, name)
    if (!deck) throw new ApiError(404, '牌组不存在')
    return deck
  }])
  routes.push(['DELETE', '/api/decks/:id', ({ params }) => {
    ws.deleteDeck(params.id)
    return { ok: true }
  }])

  // ---------- 卡片查询 ----------
  routes.push(['GET', '/api/cards', ({ query }) => ws.queryCards(parseQuery(query))])
  routes.push(['POST', '/api/cards/get', ({ body }) => {
    const ids = (body as { cardIds?: unknown }).cardIds
    if (!Array.isArray(ids)) throw new ApiError(400, 'cardIds 必须是字符串数组')
    return { cards: ws.getCards(ids.map(String)) }
  }])
  routes.push(['GET', '/api/cards/:id', ({ params }) => {
    const card = ws.getCard(params.id)
    if (!card) throw new ApiError(404, '卡片不存在')
    return card
  }])

  // ---------- 卡片增/改/删（含批量） ----------
  routes.push(['POST', '/api/cards/add', ({ body }) => {
    const b = body as { deckId?: unknown; front?: unknown; back?: unknown; items?: unknown }
    const deckId = typeof b.deckId === 'string' ? b.deckId : ''
    if (!ws.deckExists(deckId)) throw new ApiError(404, '目标牌组不存在')
    if (Array.isArray(b.items)) {
      const items = b.items.map((it) => {
        const c = normalizeContent(it)
        requireCardContent(c.front, c.back)
        return c
      })
      return { cards: ws.addCards(deckId, items) }
    }
    const single = normalizeContent(b)
    requireCardContent(single.front, single.back)
    return ws.addCard(deckId, single.front, single.back)
  }])
  routes.push(['PATCH', '/api/cards/:id', ({ params, body }) => {
    const card = ws.updateCard(params.id, parseContentPatch(body))
    if (!card) throw new ApiError(404, '卡片不存在')
    return card
  }])
  routes.push(['POST', '/api/cards/update', ({ body }) => {
    const items = (body as { items?: unknown }).items
    if (!Array.isArray(items)) throw new ApiError(400, 'items 必须是数组')
    return ws.updateCards(items.map((it) => {
      const o = (it ?? {}) as { cardId?: unknown; front?: unknown; back?: unknown }
      if (typeof o.cardId !== 'string' || !o.cardId) throw new ApiError(400, 'items[].cardId 必须是非空字符串')
      const patch = parseContentPatch(o, 'items[]')
      return { cardId: o.cardId, ...patch }
    }))
  }])
  routes.push(['POST', '/api/cards/move', ({ body }) => {
    const b = body as { cardIds?: unknown; deckId?: unknown }
    if (!Array.isArray(b.cardIds)) throw new ApiError(400, 'cardIds 必须是字符串数组')
    if (typeof b.deckId !== 'string' || !b.deckId) throw new ApiError(400, 'deckId 不能为空')
    const moved = ws.moveCards(b.cardIds.map(String), b.deckId)
    return { moved }
  }])
  routes.push(['POST', '/api/cards/reset', ({ body }) => {
    const ids = (body as { cardIds?: unknown }).cardIds
    if (!Array.isArray(ids)) throw new ApiError(400, 'cardIds 必须是字符串数组')
    return { reset: ws.resetProgress(ids.map(String)) }
  }])
  routes.push(['POST', '/api/cards/suspend', ({ body }) => {
    const b = body as { cardId?: unknown; suspended?: unknown }
    if (typeof b.cardId !== 'string') throw new ApiError(400, 'cardId 不能为空')
    const card = ws.setCardSuspended(b.cardId, Boolean(b.suspended))
    if (!card) throw new ApiError(404, '卡片不存在')
    return card
  }])
  routes.push(['POST', '/api/cards/delete', ({ body }) => {
    const ids = (body as { cardIds?: unknown }).cardIds
    if (!Array.isArray(ids)) throw new ApiError(400, 'cardIds 必须是字符串数组')
    return ws.deleteCards(ids.map(String))
  }])

  // ---------- 统计 ----------
  routes.push(['GET', '/api/stats', ({ query }) => {
    const range = query.get('range') === 'all' ? 'all' : 'year'
    const deckId = query.get('deckId') || null
    return ws.getStats({ deckId, range })
  }])

  return routes
}

function normalizeContent(it: unknown): { front: string; back: string } {
  const b = (it ?? {}) as { front?: unknown; back?: unknown }
  return { front: String(b.front ?? ''), back: String(b.back ?? '') }
}

/** 新卡内容校验：与 UI 口径一致——正反都为空才拒绝（允许仅背面卡，如cloze类） */
function requireCardContent(front: string, back: string): void {
  if (front.trim() === '' && back.trim() === '') throw new ApiError(400, 'front 与 back 不能都为空')
}

/** 部分更新解析：只透传请求里出现的字段（undefined = 保留原值），无任何内容字段则 400 */
function parseContentPatch(body: unknown, label = ''): { front?: string; back?: string } {
  const b = (body ?? {}) as { front?: unknown; back?: unknown }
  const patch: { front?: string; back?: string } = {}
  if (b.front !== undefined) patch.front = String(b.front)
  if (b.back !== undefined) patch.back = String(b.back)
  if (patch.front === undefined && patch.back === undefined) {
    throw new ApiError(400, `${label ? label + '：' : ''}至少提供 front 或 back 之一（未提供的字段保留原值）`)
  }
  return patch
}

function parseQuery(q: URLSearchParams): QueryParams {
  const keywords = (q.get('q') ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const sort = parseSort(q.get('sort'))
  // 到期窗口：数字按 ms epoch；非数字尝试按日期解析（YYYY-MM-DD 或 ISO 字符串），降低 AI/脚本传参出错率
  const dueBound = (key: string): number | null => {
    const raw = q.get(key)
    if (raw == null || raw === '') return null
    const n = Number(raw)
    if (Number.isFinite(n)) return n
    const t = Date.parse(raw)
    if (Number.isNaN(t)) throw new ApiError(400, `${key} 必须是 ms 时间戳或日期字符串（如 2026-09-30）`)
    return t
  }
  const num = (key: string): number | undefined => {
    const raw = q.get(key)
    if (raw == null || raw === '') return undefined
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new ApiError(400, `${key} 必须是数字`)
    return n
  }
  const state = q.get('state')
  return {
    deckId: q.get('deckId') || null,
    keywords,
    sort,
    limit: num('limit'),
    offset: num('offset'),
    state: state === 'new' || state === 'learning' || state === 'review' || state === 'suspended' ? state : null,
    dueAfter: dueBound('dueAfter'),
    dueBefore: dueBound('dueBefore')
  }
}

function parseSort(raw: string | null): SortKey[] {
  if (!raw) return [{ col: 'updatedAt', asc: false }]
  const keys: SortKey[] = []
  for (const part of raw.split(',')) {
    const [col, dir] = part.trim().split(':')
    if (!col) continue
    if (!SORT_COLUMNS.includes(col as BrowserColumn)) {
      throw new ApiError(400, `sort 列 ${col} 不允许（可选：${SORT_COLUMNS.join('/')}）`)
    }
    keys.push({ col: col as SortKey['col'], asc: dir !== 'desc' })
  }
  return keys.length > 0 ? keys : [{ col: 'updatedAt', asc: false }]
}

function tokenOk(expected: string, got: string | undefined): boolean {
  if (!got) return false
  // 双方先做等长 SHA-256 再比对：避免 timingSafeEqual 前置长度比较泄漏 token 长度
  const h = (s: string) => createHash('sha256').update(s, 'utf-8').digest()
  return timingSafeEqual(h(expected), h(got))
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // 不 destroy：暂停读取让 413 响应能送达客户端，响应结束后 Node 会关闭未消费完的连接
        req.pause()
        reject(new ApiError(413, '请求体过大'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
      } catch {
        reject(new ApiError(400, 'JSON 解析失败'))
      }
    })
    req.on('error', () => reject(new ApiError(400, '读取请求体失败')))
  })
}

/** 启动本机 API；config.api.enabled=false 时返回 null。端口被占用时依次顺延重试。
 *  opts.runtimeInfoPath 提供时，监听成功后把实际端口写入该文件（原子写），供 MCP wrapper 等外部工具自动发现 */
export function startApiServer(ws: WorkspaceService, opts: { runtimeInfoPath?: string } = {}): http.Server | null {
  const { enabled, port } = ws.config.api
  if (!enabled) return null
  const token = ws.config.api.token
  const routes = buildRoutes(ws)

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(payload))
    }
    try {
      // 防 DNS rebinding：Host 只允许本机回环两种写法；端口跟随实际监听端口（被占用顺延后 ≠ 配置端口）
      const host = (req.headers.host ?? '').toLowerCase()
      const expectedPort = port + attempt
      if (host !== `127.0.0.1:${expectedPort}` && host !== `localhost:${expectedPort}`) {
        return send(403, { error: 'Host 不允许' })
      }
      // 防浏览器跨站：任何带 Origin/Referer 的请求（正常 curl/脚本/AI 不带）一律拒绝
      if (req.headers.origin || req.headers.referer) {
        return send(403, { error: '不允许浏览器跨站调用' })
      }
      // 方法白名单
      const method = req.method ?? ''
      if (!['GET', 'POST', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
        return send(405, { error: '方法不允许' })
      }
      // 鉴权：health/openapi 免 token（无敏感信息，便于探活与接口自发现），其余必须携带
      if (url.pathname !== '/api/health' && url.pathname !== '/api/openapi.json') {
        const auth = req.headers.authorization ?? ''
        const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : undefined
        const header = req.headers['x-miki-token'] as string | undefined
        if (!tokenOk(token, bearer) && !tokenOk(token, header)) {
          return send(401, {
            error: '未授权：缺少或错误的 token。token 存放在当前工作区 config.json 的 api.token；若刚切换过工作区，旧 token 属于另一个工作区，请改读当前工作区的 config.json'
          })
        }
      }
      if (method === 'HEAD') return send(200, { ok: true })

      const match = matchRoute(routes, method, url.pathname)
      if (!match) return send(404, { error: '未知接口' })
      const body = method === 'POST' || method === 'PATCH' ? await readBody(req) : undefined
      const data = await match.handler({ params: match.params, query: url.searchParams, body })
      return send(200, data ?? { ok: true })
    } catch (err) {
      if (err instanceof ApiError) return send(err.status, { error: err.message })
      return send(500, { error: '内部错误' })
    }
  })

  let attempt = 0
  const tryListen = () => server.listen(port + attempt, '127.0.0.1')
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && attempt < 10) {
      attempt++
      tryListen()
      return
    }
    console.error(`[miki] HTTP API 启动失败: ${String(err.message ?? err)}`)
  })
  server.on('listening', () => {
    const addr = server.address()
    const actualPort = typeof addr === 'object' && addr ? addr.port : port
    if (opts.runtimeInfoPath) {
      // 原子写运行时信息：外部工具（MCP wrapper）读它拿实际端口，pid 用于甄别过期文件
      try {
        atomicWrite(opts.runtimeInfoPath, JSON.stringify({ port: actualPort, pid: process.pid, startedAt: Date.now() }))
      } catch (err) {
        console.error(`[miki] 运行时端口文件写入失败: ${String((err as Error).message ?? err)}`)
      }
    }
    console.log(`[miki] HTTP API: http://127.0.0.1:${actualPort}/api （token 见 config.json 的 api.token）`)
  })
  server.on('close', () => {
    if (opts.runtimeInfoPath) {
      try {
        fs.rmSync(opts.runtimeInfoPath, { force: true })
      } catch {
        // 清理失败不影响退出
      }
    }
  })
  tryListen()
  return server
}

function matchRoute(
  routes: [string, string, Handler][],
  method: string,
  pathname: string
): { handler: Handler; params: Record<string, string> } | null {
  for (const [m, pattern, handler] of routes) {
    if (m !== method) continue
    const pp = pattern.split('/')
    const up = pathname.split('/')
    if (pp.length !== up.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(up[i])
      else if (pp[i] !== up[i]) {
        ok = false
        break
      }
    }
    if (ok) return { handler, params }
  }
  return null
}
