// GithubClient 的请求细节测试：这里不验语义，只钉住"必须显式禁掉 HTTP 缓存"这一条。
//
// 为什么值得单独写：真机演练里"推送成功却报读回不一致"就是它引起的。GitHub 的 REST 响应
// 带 `cache-control: private, max-age=60`，WebView 的私有缓存会在 60 秒内直接复用旧响应，
// 于是同一次同步里"推送前读的分支头"被推送后的读回又读了一遍。Node 侧（undici）没有
// HTTP 缓存，所以真 API 演练、假 GitHub 集成测试都看不见——只有断言 fetch 的 init 才抓得住。
import { describe, expect, it, vi } from 'vitest'
import { GithubClient } from './github'
import type { SyncCreds } from './types'

const creds: SyncCreds = { repo: 'me/miki-base', branch: 'main', token: 't0ken' }

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
