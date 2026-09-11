// GithubClient 的请求细节测试：这里不验语义，只钉住"必须显式禁掉 HTTP 缓存"这一条。
//
// 为什么值得单独写：真机演练里"推送成功却报读回不一致"就是它引起的。GitHub 的 REST 响应
// 带 `cache-control: private, max-age=60`，WebView 的私有缓存会在 60 秒内直接复用旧响应，
// 于是同一次同步里"推送前读的分支头"被推送后的读回又读了一遍。Node 侧（undici）没有
// HTTP 缓存，所以真 API 演练、假 GitHub 集成测试都看不见——只有断言 fetch 的 init 才抓得住。
import { describe, expect, it, vi } from 'vitest'
import { GithubClient } from './github'
import type { SyncCreds } from './types'

const creds: SyncCreds = { repo: 'me/data-repo', branch: 'main', token: 't0ken' }

describe('GithubClient 请求', () => {
  it('所有请求都带 cache: no-store（否则 WebView 会复用旧响应）', async () => {
    const seen: (RequestInit | undefined)[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      seen.push(init)
      const body: Record<string, unknown> = String(url).includes('/git/ref/')
        ? { object: { sha: 'c1' } }
        : { tree: { sha: 't1' } }
      return { ok: true, status: 200, json: async () => body } as unknown as Response
    })
    try {
      const client = new GithubClient(creds)
      await client.head()
      expect(seen.length).toBeGreaterThan(0)
      for (const init of seen) expect(init?.cache).toBe('no-store')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// 失败的"哪种失败"必须说清：配置完点了保存只回一句"连接失败"，用户无从下手。
// 这几条钉住的是分类与措辞——尤其是 404，GitHub 用它同时表示"仓库不存在"和"token 没授权"。
describe('GithubClient 的失败分类与提示', () => {
  function stubStatus(status: number, body: unknown = {}): void {
    vi.stubGlobal('fetch', async () => {
      return {
        ok: false,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body)
      } as unknown as Response
    })
  }

  it('404 要把"仓库名错"和"token 没勾这个仓库"两种可能都说出来', async () => {
    stubStatus(404, { message: 'Not Found' })
    try {
      const r = await new GithubClient(creds).verify()
      expect(r.ok).toBe(false)
      expect(r.kind).toBe('not-found')
      expect(r.message).toContain('owner/repo')
      expect(r.message).toContain('没被授权')
      expect(r.message).toContain('HTTP 404')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('401 是凭据问题，引导去重新生成 token', async () => {
    stubStatus(401, { message: 'Bad credentials' })
    try {
      const r = await new GithubClient(creds).verify()
      expect(r.kind).toBe('auth')
      expect(r.message).toContain('重新生成')
      expect(r.message).toContain('Bad credentials')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fetch 直接抛错 = 网络问题，不能报成凭据问题', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    try {
      const r = await new GithubClient(creds).verify()
      expect(r.kind).toBe('network')
      expect(r.message).toContain('连不上 api.github.com')
      expect(r.message).not.toContain('PAT 无效')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('成功时 kind 为 null（界面据此不显示告警条）', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      const body: Record<string, unknown> = String(url).includes('/git/ref/')
        ? { object: { sha: 'abcdef1234' } }
        : { full_name: 'me/data-repo', private: true, default_branch: 'main' }
      return { ok: true, status: 200, json: async () => body } as unknown as Response
    })
    try {
      const r = await new GithubClient(creds).verify()
      expect(r.ok).toBe(true)
      expect(r.kind).toBeNull()
      expect(r.message).toContain('me/data-repo')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
