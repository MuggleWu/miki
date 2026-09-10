// @vitest-environment node
// MCP 薄壳（scripts/mcp-server.mjs）的集成测试。
//
// 这个文件此前完全没有测试，而它是 AI 客户端写生产数据的入口（add/update/move/delete 都经它
// 转发到 HTTP API），所以测法取「真链路」而不是 mock：起一个记录请求的假 HTTP API，
// 按自动发现协议铺好 userData/workspace.json + 工作区 config.json，再用官方 MCP 客户端
// 以 stdio 拉起真实的 mcp-server.mjs。断言分两层：
//   1. 客户端看到的工具结果 = 假 HTTP API 的响应（说明转发链通）；
//   2. 假 HTTP API 收到的请求 = 期望的方法/路径/查询串/请求体（说明参数拼对了、
//      日期字符串转成了 ms、批量上限生效）。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = path.join(REPO_ROOT, 'scripts', 'mcp-server.mjs')

const TOKEN = 'test-token-abc123'

interface Recorded {
  method: string
  path: string
  query: string
  body: unknown
  authorization: string | undefined
}

/** 假 HTTP API：记录每个请求并回固定结构；/health 用于 nonce 校验 */
class FakeApi {
  received: Recorded[] = []
  /** path → 响应体覆盖（默认 { ok: true }） */
  routes = new Map<string, unknown>()
  /** /api/health 回显的 nonce：模拟运行期端口文件的身份校验 */
  nonce: string | null = null
  server?: http.Server
  port = 0

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8')
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const entry: Recorded = {
          method: req.method ?? '',
          path: url.pathname,
          query: url.search,
          body: raw ? JSON.parse(raw) : undefined,
          authorization: req.headers.authorization
        }
        this.received.push(entry)
        if (url.pathname === '/api/health') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, nonce: this.nonce }))
          return
        }
        if (req.headers.authorization !== `Bearer ${TOKEN}`) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
        const body = this.routes.get(url.pathname) ?? { ok: true, path: url.pathname }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    const addr = this.server.address()
    this.port = typeof addr === 'object' && addr ? addr.port : 0
  }

  async stop(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
  }

  /** 最后一次不是 /health 的请求 */
  last(): Recorded | undefined {
    return [...this.received].reverse().find((r) => r.path !== '/api/health')
  }

  /** 满足条件的请求列表 */
  find(pred: (r: Recorded) => boolean): Recorded[] {
    return this.received.filter((r) => r.path !== '/api/health' && pred(r))
  }
}

let api: FakeApi
let userData: string
let workspace: string
let client: Client | undefined
const tmpRoots: string[] = []

/** 铺好自动发现所需的两份文件：userData/workspace.json 指针 + 工作区 config.json */
function seedDiscovery(opts: { port?: number; token?: string; enabled?: boolean; runtime?: unknown } = {}): void {
  fs.writeFileSync(path.join(userData, 'workspace.json'), JSON.stringify({ current: workspace, workspaces: [] }))
  fs.writeFileSync(
    path.join(workspace, 'config.json'),
    JSON.stringify({
      api: { enabled: opts.enabled ?? true, port: opts.port ?? api.port, token: opts.token ?? TOKEN }
    })
  )
  if (opts.runtime !== undefined) {
    fs.writeFileSync(path.join(userData, 'miki-api.json'), JSON.stringify(opts.runtime))
  } else {
    fs.rmSync(path.join(userData, 'miki-api.json'), { force: true })
  }
}

/** 拉起真实 MCP 服务器（stdio）并完成 initialize */
async function connect(env: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: os.homedir(),
      MIKI_USER_DATA: userData,
      ...env
    },
    stderr: 'pipe'
  })
  const c = new Client({ name: 'miki-test', version: '1.0.0' })
  await c.connect(transport)
  const old = client
  client = c
  if (old) await old.close().catch(() => {})
  return c
}

/** 工具抛错在 MCP 协议里表现为 isError 结果（不是 rejected promise）：取出错误文本 */
async function toolError(p: Promise<unknown>): Promise<string> {
  const res = (await p) as { content?: { type: string; text: string }[]; isError?: boolean }
  expect(res.isError).toBe(true)
  return res.content?.find((c) => c.type === 'text')?.text ?? ''
}

/** 资源内容可能是 text 或 blob，取文本并 JSON 解析 */
function resourceJson(contents: unknown[]): unknown {
  const first = contents[0] as { text?: string } | undefined
  if (typeof first?.text !== 'string') throw new Error('资源内容不是文本')
  return JSON.parse(first.text)
}

/** 读工具结果文本并 JSON 解析 */
function parseText(res: unknown): unknown {
  const content = (res as { content?: { type: string; text: string }[] }).content ?? []
  const text = content.find((c) => c.type === 'text')?.text ?? ''
  return JSON.parse(text)
}

beforeAll(async () => {
  api = new FakeApi()
  await api.start()
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'miki-mcp-userdata-'))
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'miki-mcp-ws-'))
  tmpRoots.push(userData, workspace)
})

afterAll(async () => {
  await client?.close().catch(() => {})
  await api.stop()
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true })
})

beforeEach(() => {
  api.received = []
  api.routes = new Map()
})

afterEach(async () => {
  await client?.close().catch(() => {})
  client = undefined
})

describe('MCP 薄壳：自动发现与转发', () => {
  it('按 userData 指针 + config.json 自动发现连接（无需 MIKI_TOKEN）', async () => {
    seedDiscovery()
    const c = await connect()
    expect(c.getServerVersion()?.name).toBe('miki')
    const result = (await c.callTool({ name: 'list_decks', arguments: {} })) as unknown
    expect(parseText(result)).toEqual({ ok: true, path: '/api/decks' })
    expect(api.last()).toMatchObject({ method: 'GET', path: '/api/decks', authorization: `Bearer ${TOKEN}` })
  })

  it('暴露的工具与预期清单一致（AI 客户端的可用面）', async () => {
    seedDiscovery()
    const c = await connect()
    const names = (await c.listTools()).tools.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        'add_cards',
        'api_schema',
        'create_decks',
        'delete_cards',
        'delete_deck',
        'get_cards',
        'get_stats',
        'list_decks',
        'move_cards',
        'rename_deck',
        'reset_progress',
        'search_cards',
        'set_suspended',
        'update_cards'
      ].sort()
    )
  })

  it('显式 MIKI_TOKEN 模式优先于自动发现（且不回退到配置文件）', async () => {
    seedDiscovery()
    const c = await connect({ MIKI_TOKEN: TOKEN, MIKI_PORT: String(api.port) })
    const result = (await c.callTool({ name: 'list_decks', arguments: {} })) as unknown
    expect(parseText(result)).toEqual({ ok: true, path: '/api/decks' })
  })

  it('运行时端口文件（pid 存活 + nonce 对上）优先于 config 里的端口', async () => {
    // config 故意指向一个错端口，只有采信 runtime 文件才能连通
    api.nonce = 'n-1'
    seedDiscovery({ port: 1, runtime: { port: api.port, pid: process.pid, nonce: 'n-1' } })
    const c = await connect()
    const result = (await c.callTool({ name: 'list_decks', arguments: {} })) as unknown
    expect(parseText(result)).toEqual({ ok: true, path: '/api/decks' })
  })

  it('runtime 文件 nonce 对不上（pid 复用/残留文件）→ 回退 config 端口', async () => {
    // runtime 指向真实端口但 nonce 对不上：判为过期文件，回退 config 的错端口 → 转发失败
    api.nonce = 'real-nonce'
    seedDiscovery({ port: 1, runtime: { port: api.port, pid: process.pid, nonce: 'stale-nonce' } })
    const c = await connect()
    expect(await toolError(c.callTool({ name: 'list_decks', arguments: {} }))).toMatch(
      /fetch failed|HTTP 500|ECONNREFUSED/
    )
    expect(api.find((r) => r.path === '/api/decks')).toEqual([])
  })
})

describe('MCP 薄壳：参数拼装', () => {
  beforeEach(async () => {
    seedDiscovery()
    await connect()
  })

  it('search_cards：日期字符串按本地时区转 ms，其余参数进查询串', async () => {
    await client!.callTool({
      name: 'search_cards',
      arguments: {
        deckId: 'd1',
        q: 'foo bar',
        state: 'review',
        dueAfter: '2026-09-30',
        dueBefore: 1893456000000,
        sort: 'updatedAt:desc',
        offset: 20,
        limit: 100
      }
    })
    const req = api.last()!
    expect(req.method).toBe('GET')
    expect(req.path).toBe('/api/cards')
    const usp = new URLSearchParams(req.query)
    const expected = new Date(2026, 8, 30).getTime() // 本地时区的 2026-09-30
    expect(usp.get('dueAfter')).toBe(String(expected))
    expect(usp.get('dueBefore')).toBe('1893456000000')
    expect(usp.get('deckId')).toBe('d1')
    expect(usp.get('q')).toBe('foo bar')
    expect(usp.get('state')).toBe('review')
    expect(usp.get('sort')).toBe('updatedAt:desc')
    expect(usp.get('offset')).toBe('20')
    expect(usp.get('limit')).toBe('100')
  })

  it('search_cards：缺省 limit 补 50（不让后端用默认全量）', async () => {
    await client!.callTool({ name: 'search_cards', arguments: {} })
    expect(new URLSearchParams(api.last()!.query).get('limit')).toBe('50')
  })

  it('search_cards：无法解析的日期字符串明确报错，不发请求', async () => {
    expect(await toolError(client!.callTool({ name: 'search_cards', arguments: { dueAfter: '不是日期' } }))).toMatch(
      /无法解析/
    )
    expect(api.last()).toBeUndefined()
  })

  it('写工具转发到同名 HTTP 写接口，body 原样带过去', async () => {
    await client!.callTool({ name: 'create_decks', arguments: { names: ['A', 'B'] } })
    expect(api.last()).toMatchObject({ method: 'POST', path: '/api/decks', body: { names: ['A', 'B'] } })

    await client!.callTool({ name: 'add_cards', arguments: { deckId: 'd1', items: [{ front: 'f', back: 'b' }] } })
    expect(api.last()).toMatchObject({
      method: 'POST',
      path: '/api/cards/add',
      body: { deckId: 'd1', items: [{ front: 'f', back: 'b' }] }
    })

    await client!.callTool({ name: 'move_cards', arguments: { cardIds: ['c1', 'c2'], deckId: 'd2' } })
    expect(api.last()).toMatchObject({
      method: 'POST',
      path: '/api/cards/move',
      body: { cardIds: ['c1', 'c2'], deckId: 'd2' }
    })

    await client!.callTool({ name: 'delete_deck', arguments: { deckId: 'd9' } })
    expect(api.last()).toMatchObject({ method: 'DELETE', path: '/api/decks/d9' })

    await client!.callTool({ name: 'rename_deck', arguments: { deckId: 'd9', name: '新名' } })
    expect(api.last()).toMatchObject({ method: 'PATCH', path: '/api/decks/d9', body: { name: '新名' } })

    await client!.callTool({ name: 'get_cards', arguments: { cardIds: ['c1'] } })
    expect(api.last()).toMatchObject({ method: 'POST', path: '/api/cards/get', body: { cardIds: ['c1'] } })
  })

  it('get_stats / api_schema 走只读端点', async () => {
    await client!.callTool({ name: 'get_stats', arguments: { deckId: 'd1', range: 'year' } })
    const usp = new URLSearchParams(api.last()!.query)
    expect(api.last()!.path).toBe('/api/stats')
    expect(usp.get('deckId')).toBe('d1')
    expect(usp.get('range')).toBe('year')

    await client!.callTool({ name: 'api_schema', arguments: {} })
    expect(api.last()).toMatchObject({ method: 'GET', path: '/api/openapi.json' })
  })

  it('set_suspended：逐卡并发请求，单项失败不中断其余且计数只算成功', async () => {
    // 让 c2 的 suspend 请求失败：按 body 里 cardId 区分响应
    api.routes.set('/api/cards/suspend', { ok: true })
    const original = api.server!.listeners('request')[0] as (
      req: http.IncomingMessage,
      res: http.ServerResponse
    ) => void
    api.server!.removeAllListeners('request')
    api.server!.on('request', (req, res) => {
      if (req.url?.startsWith('/api/cards/suspend')) {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { cardId: string }
          api.received.push({
            method: req.method ?? '',
            path: '/api/cards/suspend',
            query: '',
            body,
            authorization: req.headers.authorization
          })
          if (body.cardId === 'c2') {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'boom' }))
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        })
        return
      }
      original(req, res)
    })

    const result = (await client!.callTool({
      name: 'set_suspended',
      arguments: { cardIds: ['c1', 'c2', 'c3'], suspended: true }
    })) as unknown
    const out = parseText(result) as {
      succeeded: number
      failed: number
      suspended: number
      cards: { cardId: string; ok: boolean }[]
    }
    expect(out.succeeded).toBe(2)
    expect(out.failed).toBe(1)
    expect(out.suspended).toBe(2)
    expect(out.cards).toEqual([
      { cardId: 'c1', ok: true },
      { cardId: 'c2', ok: false, error: expect.stringContaining('HTTP 500') },
      { cardId: 'c3', ok: true }
    ])
  })

  it('批量上限：cardIds 超过 500 被 schema 拒绝（防一次误传全库）', async () => {
    const many = Array.from({ length: 501 }, (_, i) => `c${i}`)
    expect(await toolError(client!.callTool({ name: 'delete_cards', arguments: { cardIds: many } }))).toMatch(
      /500|too_big|500/
    )
    expect(api.last()).toBeUndefined()
  })

  it('401 时给出「token 与工作区不匹配」的修复提示，而不是裸 HTTP 错误', async () => {
    api.routes = new Map()
    const c = await connect({ MIKI_TOKEN: 'wrong-token', MIKI_PORT: String(api.port) })
    expect(await toolError(c.callTool({ name: 'list_decks', arguments: {} }))).toMatch(/401 未授权/)
  })
})

describe('MCP 薄壳：只读资源', () => {
  it('decks / stats 资源可读', async () => {
    seedDiscovery()
    const c = await connect()
    const decks = await c.readResource({ uri: 'miki://decks' })
    expect(resourceJson(decks.contents)).toEqual({ ok: true, path: '/api/decks' })
    const stats = await c.readResource({ uri: 'miki://stats' })
    expect(resourceJson(stats.contents)).toEqual({ ok: true, path: '/api/stats' })
    expect(new URLSearchParams(api.last()!.query).get('range')).toBe('year')
  })

  it('make-cards prompt：带 deckId 时要求调用 add_cards，不带则只出清单', async () => {
    seedDiscovery()
    const c = await connect()
    const withDeck = await c.getPrompt({ name: 'make-cards', arguments: { topic: 'FSRS', deckId: 'd1' } })
    const textWith = JSON.stringify(withDeck.messages)
    expect(textWith).toContain('FSRS')
    expect(textWith).toContain('add_cards')
    expect(textWith).toContain('d1')

    const noDeck = await c.getPrompt({ name: 'make-cards', arguments: { topic: 'FSRS' } })
    const textNo = JSON.stringify(noDeck.messages)
    expect(textNo).toContain('只输出清单，不调用导入工具')
    expect(textNo).not.toContain('调用 add_cards 工具导入')
  })
})
