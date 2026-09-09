// HTTP API 集成测试：真实监听 127.0.0.1，覆盖安全链（token/Host/Origin）与 CRUD 全流程
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { WorkspaceService } from '../workspace'
import { startApiServer } from '../api-server'

const PORT = 18477
const BASE = `http://127.0.0.1:${PORT}`
let ws: WorkspaceService
let token = ''

function request(
  method: string,
  urlPath: string,
  opts: { body?: unknown; token?: string | null; origin?: string; host?: string } = {}
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? null : JSON.stringify(opts.body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: urlPath,
        method,
        headers: {
          ...(opts.host !== undefined ? { host: opts.host } : {}),
          ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {})
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8')
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null })
        })
      }
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function authed(method: string, urlPath: string, body?: unknown) {
  return request(method, urlPath, { body, token })
}

let server: http.Server | null = null
let tmpDir = ''

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miki-api-test-'))
  ws = new WorkspaceService()
  ws.init(tmpDir)
  // 测试用冷门固定端口（startApiServer 启动时只读一次）
  ws.config.api.port = PORT
  token = ws.config.api.token
  server = startApiServer(ws)
})

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('http api 安全链', () => {
  it('health 免 token', async () => {
    const r = await request('GET', '/api/health')
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, name: 'miki' })
  })

  it('openapi 免 token 可取，且结构自洽', async () => {
    const r = await request('GET', '/api/openapi.json')
    expect(r.status).toBe(200)
    const doc = r.json as { openapi: string; paths: Record<string, unknown> }
    expect(doc.openapi).toMatch(/^3\./)
    expect(Object.keys(doc.paths)).toContain('/cards/add')
  })

  it('缺 token 与错 token 都 401，提示含工作区线索', async () => {
    const noToken = await request('GET', '/api/decks')
    expect(noToken.status).toBe(401)
    expect((noToken.json as { error: string }).error).toContain('工作区')
    const badToken = await request('GET', '/api/decks', { token: 'wrong' })
    expect(badToken.status).toBe(401)
  })

  it('带 Origin 的请求一律 403（防浏览器跨站）', async () => {
    const r = await request('GET', '/api/decks', { token, origin: 'http://evil.example' })
    expect(r.status).toBe(403)
  })

  it('伪造 Host 403（防 DNS rebinding）', async () => {
    const r = await request('GET', '/api/decks', { token, host: 'evil.example:80' })
    expect(r.status).toBe(403)
  })

  it('未知接口 404，错误方法 405', async () => {
    expect((await authed('GET', '/api/nope')).status).toBe(404)
    expect((await authed('PUT', '/api/decks')).status).toBe(405)
  })

  it('HEAD 探活：已知接口 200、未知接口 404（与 GET 同一套路由）', async () => {
    expect((await request('HEAD', '/api/decks', { token })).status).toBe(200)
    expect((await request('HEAD', '/api/nope', { token })).status).toBe(404)
  })

  it('畸形百分号编码 400（不再冒成 500）', async () => {
    expect((await authed('GET', '/api/cards/%zz')).status).toBe(400)
  })

  it('非法 JSON 400', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: PORT, path: '/api/decks', method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        }
      )
      req.on('error', reject)
      req.write('{bad json')
      req.end()
    })
    expect(status).toBe(400)
  })
})

describe('http api 牌组与卡片 CRUD', () => {
  let deckId = ''
  const cardIds: string[] = []

  it('批量建牌组', async () => {
    const r = await authed('POST', '/api/decks', { names: ['API 组 A', 'API 组 B'] })
    expect(r.status).toBe(200)
    const decks = (r.json as { decks: { id: string; name: string }[] }).decks
    expect(decks.map((d) => d.name)).toContain('API 组 A')
    deckId = decks.find((d) => d.name === 'API 组 A')!.id
  })

  it('单建牌组与重名校验', async () => {
    expect((await authed('POST', '/api/decks', { name: '' })).status).toBe(400)
    const r = await authed('POST', '/api/decks', { name: 'API 组 C' })
    expect(r.status).toBe(200)
  })

  it('批量加卡：一次两张，同批时间戳', async () => {
    const r = await authed('POST', '/api/cards/add', {
      deckId,
      items: [
        { front: '正面一', back: '背面一' },
        { front: '正面二', back: '背面二' }
      ]
    })
    expect(r.status).toBe(200)
    const cards = (r.json as { cards: { id: string; createdAt: number; fsrs: null }[] }).cards
    expect(cards).toHaveLength(2)
    expect(cards[0].createdAt).toBe(cards[1].createdAt)
    expect(cards[0].fsrs).toBeNull()
    cardIds.push(...cards.map((c) => c.id))
  })

  it('加卡到不存在的牌组 404；正反都为空 400（单张与批量一致）', async () => {
    const r = await authed('POST', '/api/cards/add', { deckId: 'nope', items: [{ front: 'x', back: 'y' }] })
    expect(r.status).toBe(404)
    expect((await authed('POST', '/api/cards/add', { deckId, front: '', back: '  ' })).status).toBe(400)
    expect(
      (await authed('POST', '/api/cards/add', { deckId, items: [{ front: 'ok', back: 'y' }, { front: '', back: '' }] })).status
    ).toBe(400)
  })

  it('查询：关键词/状态/到期窗口/分页', async () => {
    const byKw = await authed('GET', `/api/cards?q=${encodeURIComponent('正面一')}`)
    expect((byKw.json as { total: number }).total).toBe(1)
    const newState = await authed('GET', '/api/cards?state=new')
    expect((newState.json as { total: number }).total).toBeGreaterThanOrEqual(2)
    const paged = await authed('GET', '/api/cards?limit=1&offset=1')
    const paged0 = await authed('GET', '/api/cards?limit=1&offset=0')
    expect((paged0.json as { rows: unknown[] }).rows).toHaveLength(1)
    expect((paged.json as { rows: unknown[] }).rows).toHaveLength(1)
    const due = await authed('GET', `/api/cards?dueBefore=${Date.now()}`)
    expect((due.json as { total: number }).total).toBe(0) // 新卡无调度进度，不在到期窗口内
  })

  it('单张取卡与单张部分改内容', async () => {
    const got = await authed('GET', `/api/cards/${cardIds[0]}`)
    expect(got.status).toBe(200)
    expect((got.json as { id: string }).id).toBe(cardIds[0])
    expect((await authed('GET', '/api/cards/not-exist')).status).toBe(404)

    // 只传 front：back 保留原值（部分更新）
    const patched = await authed('PATCH', `/api/cards/${cardIds[0]}`, { front: '正面一改' })
    expect((patched.json as { front: string }).front).toBe('正面一改')
    expect((patched.json as { back: string }).back).toBe('背面一')
    // PATCH 不带任何内容字段 400
    expect((await authed('PATCH', `/api/cards/${cardIds[0]}`, {})).status).toBe(400)
  })

  it('批量部分改内容与缺失计数；sort 非法列 400；due 参数接受日期字符串', async () => {
    const r = await authed('POST', '/api/cards/update', {
      items: [
        { cardId: cardIds[0], front: '批量一' }, // 只改正面
        { cardId: 'missing-id', front: 'x', back: 'y' }
      ]
    })
    expect(r.json).toEqual({ updated: 1, missing: 1 })
    const after = (await authed('GET', `/api/cards/${cardIds[0]}`)).json as { front: string; back: string }
    expect(after).toEqual({ ...after, front: '批量一', back: '背面一' })
    // items 里没有任何内容字段 → 400
    expect((await authed('POST', '/api/cards/update', { items: [{ cardId: cardIds[0] }] })).status).toBe(400)

    expect((await authed('GET', '/api/cards?sort=nope:asc')).status).toBe(400)
    const due = await authed('GET', `/api/cards?dueBefore=${encodeURIComponent('2026-09-30')}`)
    expect(due.status).toBe(200)
    const badDue = await authed('GET', '/api/cards?dueBefore=not-a-date')
    expect(badDue.status).toBe(400)
  })

  it('暂停后按状态过滤命中', async () => {
    await authed('POST', '/api/cards/suspend', { cardId: cardIds[1], suspended: true })
    const suspended = await authed('GET', '/api/cards?state=suspended')
    const rows = (suspended.json as { rows: { id: string }[] }).rows
    expect(rows.map((r) => r.id)).toContain(cardIds[1])
    await authed('POST', '/api/cards/suspend', { cardId: cardIds[1], suspended: false })
  })

  it('批量移动到另一牌组', async () => {
    const decks = (await authed('GET', '/api/decks')).json as { decks: { id: string; name: string }[] }
    const target = decks.decks.find((d) => d.name === 'API 组 B')!.id
    const r = await authed('POST', '/api/cards/move', { cardIds: [cardIds[0]], deckId: target })
    expect(r.json).toEqual({ moved: 1 })
    expect((await authed('GET', `/api/cards/${cardIds[0]}`)).json).toMatchObject({ deckId: target })
  })

  it('批量删除含缺失 ID，计数正确；删除后查询不出现', async () => {
    const r = await authed('POST', '/api/cards/delete', { cardIds: [...cardIds, 'missing-id'] })
    expect(r.json).toEqual({ deleted: cardIds.length, missing: 1 })
    const left = await authed('GET', `/api/cards/${cardIds[0]}`)
    expect(left.status).toBe(200) // 软删：getCard 仍可取到（deletedAt 标记），查询接口不再展示
    const q = await authed('GET', `/api/cards?deckId=${deckId}`)
    expect((q.json as { total: number }).total).toBe(0)
  })

  it('统计接口可用', async () => {
    const r = await authed('GET', '/api/stats?range=year')
    expect(r.status).toBe(200)
    expect(r.json).toHaveProperty('stateCounts')
  })
})

describe('端口被占用顺延后，Host 校验跟随实际监听端口', () => {
  const OCCUPIED = 18478
  let blocker: http.Server | null = null
  let server2: http.Server | null = null
  let tmp2 = ''

  /** host 头由调用方指定，打探 health 的状态码 */
  const probe = (port: number, host: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/health', method: 'GET', headers: { host } },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        }
      )
      req.on('error', reject)
      req.end()
    })

  afterAll(async () => {
    await new Promise<void>((resolve) => server2?.close(() => resolve()))
    await new Promise<void>((resolve) => blocker?.close(() => resolve()))
    fs.rmSync(tmp2, { recursive: true, force: true })
  })

  it('Host 用被占端口 403、用顺延后的实际端口 200', async () => {
    blocker = http.createServer().listen(OCCUPIED, '127.0.0.1')
    await new Promise<void>((resolve) => blocker!.once('listening', () => resolve()))
    tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'miki-api-port-'))
    const ws2 = new WorkspaceService()
    ws2.init(tmp2)
    ws2.config.api.port = OCCUPIED
    const runtimeFile = path.join(tmp2, 'miki-api.json')
    server2 = startApiServer(ws2, { runtimeInfoPath: runtimeFile })

    // 等顺延监听成功（health 打探实际端口，最多 2s）
    let ready = false
    for (let i = 0; i < 20 && !ready; i++) {
      try {
        await probe(OCCUPIED + 1, `127.0.0.1:${OCCUPIED + 1}`)
        ready = true
      } catch {
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    expect(ready).toBe(true)

    // 运行时文件记录顺延后的实际端口，供外部工具自动发现
    const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf-8')) as { port: number; pid: number }
    expect(runtime.port).toBe(OCCUPIED + 1)
    expect(runtime.pid).toBeGreaterThan(0)

    expect(await probe(OCCUPIED + 1, `127.0.0.1:${OCCUPIED}`)).toBe(403) // 配置端口（已被占）不是合法 Host
    expect(await probe(OCCUPIED + 1, `127.0.0.1:${OCCUPIED + 1}`)).toBe(200) // 实际监听端口放行
  })
})
