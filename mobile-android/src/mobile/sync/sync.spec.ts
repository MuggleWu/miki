// 同步编排的集成测试：假 GitHub（实现 Git Data API 的几个端点，内存里维护 tree/commit/ref）
// + 内存文件系统，把"拉取 → 合并 → 落地 → 重放校验 → 快照 → 推送 → 读回"整条链跑一遍。
//
// 为什么值得写这一层：M5 的核心风险是"自建同步代码的正确性"，而真机演练需要真 PAT 才能做。
// 这里用假 GitHub 把编排的每一段都走通（包括 fast-forward 冲突），unit 层没覆盖的
// "谁先谁后、读回校验有没有生效、冲突有没有被拦住"都在这里定型。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryFileStore } from '../fs/memory-fs'
import { MobilePaths } from '../paths'
import { runSync } from './index'
import { emptyBase, type SyncBase, type SyncCreds } from './types'

const ROOT = 'miki-base'
const paths = new MobilePaths(ROOT)
const creds: SyncCreds = { repo: 'me/data-repo', branch: 'main', token: 't0ken' }

/** 假 GitHub：只实现 runSync 用到的端点，但语义与真的一致（尤其 422 冲突与 blob 内容） */
class FakeGithub {
  blobs = new Map<string, string>()
  files = new Map<string, string>() // path → blob sha
  commit = 'c0'
  /** 每次 createCommit 自增，用来判断分支头真的动了 */
  private seq = 0
  /** 让下一次 updateRef 失败（模拟"远端在我们读取之后被别人推过"） */
  conflictOnNextRef = false
  refUpdates = 0
  commitMessages: string[] = []

  treeSha(): string {
    return `tree-${this.commit}`
  }

  private shaOfText(text: string): string {
    const sha = `b${this.blobs.size}-${text.length}`
    this.blobs.set(sha, text)
    return sha
  }

  /** 远端写入（模拟桌面端 push） */
  push(path: string, text: string): void {
    this.files.set(path, this.shaOfText(text))
    this.commit = `c${++this.seq}`
  }

  handle(method: string, url: string, body?: string): { status: number; json: unknown } {
    const path = url.replace('https://api.github.com', '')
    const j = body ? (JSON.parse(body) as Record<string, unknown>) : {}

    if (method === 'GET' && path.startsWith('/repos/')) {
      if (path === `/repos/${creds.repo}`) return { status: 200, json: { full_name: creds.repo, private: true } }
      if (path.endsWith(`/git/ref/heads/${creds.branch}`))
        return { status: 200, json: { object: { sha: this.commit } } }
      if (path.includes('/git/commits/')) return { status: 200, json: { tree: { sha: this.treeSha() } } }
      if (path.includes('/git/trees/')) {
        return {
          status: 200,
          json: {
            truncated: false,
            tree: [...this.files].map(([p, sha]) => ({
              path: p,
              type: 'blob',
              sha,
              size: this.blobs.get(sha)?.length ?? 0
            }))
          }
        }
      }
      if (path.includes('/git/blobs/')) {
        const sha = path.split('/').pop()!
        const content = this.blobs.get(sha) ?? ''
        return { status: 200, json: { content: Buffer.from(content, 'utf8').toString('base64'), encoding: 'base64' } }
      }
    }
    if (method === 'POST' && path.endsWith('/git/blobs')) {
      const text = Buffer.from(String(j.content), 'base64').toString('utf8')
      return { status: 200, json: { sha: this.shaOfText(text) } }
    }
    if (method === 'POST' && path.endsWith('/git/trees')) {
      for (const e of (j.tree as { path: string; sha: string }[]) ?? []) this.files.set(e.path, e.sha)
      return { status: 200, json: { sha: this.treeSha() } }
    }
    if (method === 'POST' && path.endsWith('/git/commits')) {
      this.commitMessages.push(String(j.message))
      this.commit = `c${++this.seq}`
      return { status: 200, json: { sha: this.commit } }
    }
    if (method === 'PATCH' && path.includes('/git/refs/heads/')) {
      this.refUpdates++
      if (this.conflictOnNextRef) {
        this.conflictOnNextRef = false
        return { status: 422, json: { message: 'Update is not a fast forward' } }
      }
      this.commit = String(j.sha)
      return { status: 200, json: { object: { sha: this.commit } } }
    }
    return { status: 404, json: { message: `no route ${method} ${path}` } }
  }
}

let gh: FakeGithub

beforeEach(() => {
  gh = new FakeGithub()
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const res = gh.handle(init?.method ?? 'GET', String(url), init?.body as string | undefined)
    return { ok: res.status < 400, status: res.status, json: async () => res.json } as unknown as Response
  })
  // WebCrypto 在 node 里挂在 globalThis.crypto 上（vitest 默认就有），这里只兜底
  if (!globalThis.crypto?.subtle) throw new Error('本测试需要 crypto.subtle')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const row = (o: Record<string, unknown>): string => JSON.stringify(o) + '\n'

/** 假的"重放校验"：返回当前文件的行数（真实现会整份重载工作区） */
function verifyFrom(store: MemoryFileStore) {
  return async (): Promise<{ eventCount: number; damaged: number; truncated: number; cards: number }> => {
    let n = 0
    for (const p of ['cards/d1.ndjson', 'review-log/2026-09.ndjson']) {
      const t = await store.readText(`${ROOT}/${p}`)
      if (t) n += t.split('\n').filter((l) => l.trim()).length
    }
    return { eventCount: n, damaged: 0, truncated: 0, cards: 0 }
  }
}

describe('runSync 编排', () => {
  it('首次同步：本地为空 → 全部拉下来，不产生 commit', async () => {
    gh.push('decks.json', '[{"id":"d1","name":"A"}]')
    gh.push('cards/d1.ndjson', row({ id: 'c1', front: 'q' }))
    const store = new MemoryFileStore()
    const out = await runSync({ store, paths, reloadAndVerify: verifyFrom(store) }, creds, emptyBase(), 'full')

    expect(out.report.ok).toBe(true)
    expect(out.report.pulled).toBe(2)
    expect(out.report.pushed).toBe(0)
    expect(gh.refUpdates).toBe(0)
    expect(await store.readText(`${ROOT}/decks.json`)).toBe('[{"id":"d1","name":"A"}]')
  })

  it('本地有新增、远端没动 → 推送一条 commit，并读回校验', async () => {
    gh.push('review-log/2026-09.ndjson', row({ action: 'answer', cardId: 'c1', t: 1, rating: 3 }))
    const store = new MemoryFileStore()
    await store.writeText(`${ROOT}/review-log/2026-09.ndjson`, row({ action: 'answer', cardId: 'c1', t: 1, rating: 3 }))
    // 先同步一次拿到 base（此时本地与远端一致）
    const first = await runSync({ store, paths, reloadAndVerify: verifyFrom(store) }, creds, emptyBase(), 'full')
    expect(first.report.pushed).toBe(0)

    // 手机上又答了一题
    await store.appendText(
      `${ROOT}/review-log/2026-09.ndjson`,
      row({ action: 'answer', cardId: 'c2', t: 2, rating: 4 })
    )
    const second = await runSync({ store, paths, reloadAndVerify: verifyFrom(store) }, creds, first.base, 'full')

    expect(second.report.ok).toBe(true)
    expect(second.report.pushed).toBe(1)
    expect(second.report.commit).toBeTruthy()
    expect(gh.refUpdates).toBe(1)
    expect(gh.commitMessages[0]).toContain('mobile: sync')
    expect(gh.commitMessages[0]).toContain('1 reviews')
    // 远端真的拿到两行
    const remoteSha = gh.files.get('review-log/2026-09.ndjson')!
    expect(gh.blobs.get(remoteSha)!.trim().split('\n')).toHaveLength(2)
  })

  // 真机演练抓到的 bug：contents 是按 toPush 生成的，却按 files（全量）的下标去取，
  // 于是只要有别的文件排在前面（cards/* 排在 review-log/* 前面），计数就永远落在别人身上 → 0。
  it('推送计数按文件对齐：目录里有其他文件时也要算对（回归）', async () => {
    const card = row({ id: 'c1', front: 'q' })
    const ev1 = row({ action: 'answer', cardId: 'c1', t: 1, rating: 3 })
    gh.push('cards/d1.ndjson', card)
    gh.push('review-log/2026-09.ndjson', ev1)
    const store = new MemoryFileStore()
    await store.writeText(`${ROOT}/cards/d1.ndjson`, card)
    await store.writeText(`${ROOT}/review-log/2026-09.ndjson`, ev1)
    const first = await runSync({ store, paths, reloadAndVerify: verifyFrom(store) }, creds, emptyBase(), 'full')
    expect(first.report.pushed).toBe(0)

    // 手机上答了一题：只有 review-log 该被推，它排在 cards/d1.ndjson 后面
    await store.appendText(
      `${ROOT}/review-log/2026-09.ndjson`,
      row({ action: 'answer', cardId: 'c2', t: 2, rating: 4 })
    )
    const second = await runSync({ store, paths, reloadAndVerify: verifyFrom(store) }, creds, first.base, 'full')

    expect(second.report.ok).toBe(true)
    expect(second.report.pushed).toBe(1)
    expect(second.report.reviews).toBe(1)
    expect(gh.commitMessages[0]).toContain('1 reviews')
  })

  it('两端各自追加 → 行合并后推上去，两侧内容一致', async () => {
    const shared = row({ action: 'answer', cardId: 'c0', t: 0, rating: 3 })
    gh.push('review-log/2026-09.ndjson', shared)
    const store = new MemoryFileStore()
    await store.writeText(`${ROOT}/review-log/2026-09.ndjson`, shared)
    const first = await runSync({ store, paths, reloadAndVerify: verifyFrom(store) }, creds, emptyBase(), 'full')

    // 桌面端追加一条并推送；手机上也答了一题
    gh.push('review-log/2026-09.ndjson', shared + row({ action: 'answer', cardId: 'desktop', t: 10, rating: 1 }))
    await store.appendText(
      `${ROOT}/review-log/2026-09.ndjson`,
      row({ action: 'answer', cardId: 'phone', t: 20, rating: 4 })
    )

    const out = await runSync({ store, paths, reloadAndVerify: verifyFrom(store) }, creds, first.base, 'full')

    expect(out.report.ok).toBe(true)
    const local = await store.readText(`${ROOT}/review-log/2026-09.ndjson`)
    const remoteSha = gh.files.get('review-log/2026-09.ndjson')!
    const remote = gh.blobs.get(remoteSha)!
    expect(local).toBe(remote) // 两侧收敛到同一份内容
    const ids = local!
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).cardId)
    expect(ids).toEqual(['c0', 'desktop', 'phone']) // 远端为骨架，本地新增接在末尾
  })

  it('推送时远端被别人推过 → fast-forward 失败，抛出冲突（不覆盖别人的提交）', async () => {
    gh.push('review-log/2026-09.ndjson', row({ action: 'answer', cardId: 'c0', t: 0, rating: 3 }))
    const store = new MemoryFileStore()
    await store.writeText(`${ROOT}/review-log/2026-09.ndjson`, row({ action: 'answer', cardId: 'c0', t: 0, rating: 3 }))
    const first = await runSync({ store, paths, reloadAndVerify: verifyFrom(store) }, creds, emptyBase(), 'full')

    await store.appendText(
      `${ROOT}/review-log/2026-09.ndjson`,
      row({ action: 'answer', cardId: 'mine', t: 5, rating: 4 })
    )
    gh.conflictOnNextRef = true
    await expect(
      runSync({ store, paths, reloadAndVerify: verifyFrom(store) }, creds, first.base, 'full')
    ).rejects.toThrow(/422|fast forward/)
  })

  it('推送前留下快照（工作区整份复制到 <root>-backups）', async () => {
    gh.push('review-log/2026-09.ndjson', row({ action: 'answer', cardId: 'c0', t: 0, rating: 3 }))
    const store = new MemoryFileStore()
    const first = await runSync({ store, paths, reloadAndVerify: verifyFrom(store) }, creds, emptyBase(), 'full')
    await store.appendText(`${ROOT}/review-log/2026-09.ndjson`, row({ action: 'answer', cardId: 'x', t: 1, rating: 3 }))
    const out = await runSync({ store, paths, reloadAndVerify: verifyFrom(store) }, creds, first.base, 'full')

    expect(out.report.snapshot).toBeTruthy()
    const backups = await store.list(`${ROOT}-backups`)
    expect(backups.filter((e) => e.type === 'directory')).toHaveLength(1)
    const snap = await store.readText(`${ROOT}-backups/${out.report.snapshot}/review-log/2026-09.ndjson`)
    expect(snap).toContain('c0')
  })

  it('重放校验发现坏行 → 停止同步、不推送', async () => {
    // 只有"本次真的有东西写进本地"才会走到重放校验（没有写入就没什么可校验的，
    // 见 runSync 里那条 `if (toWrite.length > 0)`）：所以先建立 base，再让远端多一行，
    // 这样本次是一次纯拉取落地。
    const ev1 = row({ action: 'answer', cardId: 'c0', t: 0, rating: 3 })
    gh.push('review-log/2026-09.ndjson', ev1)
    const store = new MemoryFileStore()
    await store.writeText(`${ROOT}/review-log/2026-09.ndjson`, ev1)
    const first = await runSync({ store, paths, reloadAndVerify: verifyFrom(store) }, creds, emptyBase(), 'full')
    gh.push('review-log/2026-09.ndjson', ev1 + row({ action: 'answer', cardId: 'c1', t: 1, rating: 3 }))

    await expect(
      runSync(
        { store, paths, reloadAndVerify: async () => ({ eventCount: 0, damaged: 2, truncated: 0, cards: 0 }) },
        creds,
        first.base,
        'full'
      )
    ).rejects.toThrow(/坏行/)
    // 校验没过 → 一个 commit 都不该产生（测试名里的"不推送"）
    expect(gh.refUpdates).toBe(0)
  })
})

describe('记账', () => {
  it('同步后回写 base：下次同步能识别"远端没动"从而不下载文件', async () => {
    gh.push('decks.json', '[{"id":"d1"}]')
    const store = new MemoryFileStore()
    const first = await runSync({ store, paths, reloadAndVerify: verifyFrom(store) }, creds, emptyBase(), 'full')
    expect(Object.keys(first.base.remoteSha)).toContain('decks.json')
    expect(first.base.commit).toBe(gh.commit)

    const second: SyncBase = first.base
    const out = await runSync({ store, paths, reloadAndVerify: verifyFrom(store) }, creds, second, 'full')
    expect(out.report.message).toContain('已是最新')
  })
})

describe('只拉模式（回前台的自动同步）', () => {
  // 用户 报的 bug：说好"回前台静默拉一次"，结果把手机上攒的进度也推上去了。
  it('本地有新进度、远端没动 → 绝不推送，远端一行都不多（回归）', async () => {
    const ev1 = row({ action: 'answer', cardId: 'c1', t: 1, rating: 3 })
    gh.push('review-log/2026-09.ndjson', ev1)
    const store = new MemoryFileStore()
    await store.writeText(`${ROOT}/review-log/2026-09.ndjson`, ev1)
    const first = await runSync({ store, paths, reloadAndVerify: verifyFrom(store) }, creds, emptyBase(), 'full')
    expect(first.report.pushed).toBe(0)

    // 手机上答了一题（只在本机）
    const ev2 = row({ action: 'answer', cardId: 'c2', t: 2, rating: 4 })
    await store.appendText(`${ROOT}/review-log/2026-09.ndjson`, ev2)

    const auto = await runSync({ store, paths, reloadAndVerify: verifyFrom(store) }, creds, first.base, 'pull-only')

    expect(auto.report.ok).toBe(true)
    expect(auto.report.pushed).toBe(0)
    expect(auto.report.commit).toBeNull()
    expect(gh.refUpdates).toBe(0) // 一次 ref 更新都没有
    expect(gh.commitMessages).toHaveLength(0) // 也就没有任何 commit
    // 远端那份内容还和原来一模一样
    expect(gh.blobs.get(gh.files.get('review-log/2026-09.ndjson')!)).toBe(ev1)
    // 本机那条也还在（只拉模式不该动它）
    expect(await store.readText(`${ROOT}/review-log/2026-09.ndjson`)).toContain('"c2"')
  })

  it('远端有新文件 → 拉下来；记账推进到远端头', async () => {
    const store = new MemoryFileStore()
    const first = await runSync({ store, paths, reloadAndVerify: verifyFrom(store) }, creds, emptyBase(), 'full')
    gh.push('decks.json', '[{"id":"d1","name":"新牌组"}]')

    const auto = await runSync({ store, paths, reloadAndVerify: verifyFrom(store) }, creds, first.base, 'pull-only')

    expect(auto.report.pulled).toBe(1)
    expect(auto.report.pushed).toBe(0)
    expect(gh.refUpdates).toBe(0)
    expect(await store.readText(`${ROOT}/decks.json`)).toBe('[{"id":"d1","name":"新牌组"}]')
    expect(auto.base.commit).toBe(gh.commit)

    // 再做一次：这次两边一致，什么都不用做
    const again = await runSync({ store, paths, reloadAndVerify: verifyFrom(store) }, creds, auto.base, 'pull-only')
    expect(again.report.pulled).toBe(0)
    expect(again.report.message).toContain('已是最新')
  })

  it('两边都动过 → 只拉模式不碰不推、记账也不推进；下次手动推送两边内容都不丢（回归）', async () => {
    const ev1 = row({ action: 'answer', cardId: 'c1', t: 1, rating: 3 })
    gh.push('review-log/2026-09.ndjson', ev1)
    const store = new MemoryFileStore()
    await store.writeText(`${ROOT}/review-log/2026-09.ndjson`, ev1)
    const first = await runSync({ store, paths, reloadAndVerify: verifyFrom(store) }, creds, emptyBase(), 'full')

    // 桌面端答了一题（远端前进），同时手机上也答了一题
    const ev2 = row({ action: 'answer', cardId: 'c2', t: 2, rating: 4 })
    const ev3 = row({ action: 'answer', cardId: 'c3', t: 3, rating: 2 })
    gh.push('review-log/2026-09.ndjson', ev1 + ev2)
    await store.appendText(`${ROOT}/review-log/2026-09.ndjson`, ev3)

    const auto = await runSync({ store, paths, reloadAndVerify: verifyFrom(store) }, creds, first.base, 'pull-only')

    expect(auto.report.pushed).toBe(0)
    expect(gh.refUpdates).toBe(0)
    // 记账停在原地：推进了的话，下次同步会以为"远端没变过"，ev2 就永远拉不回来了
    expect(auto.base.commit).toBe(first.base.commit)
    const local = await store.readText(`${ROOT}/review-log/2026-09.ndjson`)
    expect(local).toContain('"c3"') // 本机那条还在
    expect(local).not.toContain('"c2"') // 也没偷偷把远端的合并进来

    // 用户点"推送进度"：两边的内容都要落地，一条不丢
    const manual = await runSync({ store, paths, reloadAndVerify: verifyFrom(store) }, creds, auto.base, 'full')
    expect(manual.report.pushed).toBe(1)
    expect(gh.refUpdates).toBe(1)
    const remote = gh.blobs.get(gh.files.get('review-log/2026-09.ndjson')!)!
    for (const id of ['c1', 'c2', 'c3']) expect(remote).toContain(`"${id}"`)
    const localAfter = await store.readText(`${ROOT}/review-log/2026-09.ndjson`)
    for (const id of ['c1', 'c2', 'c3']) expect(localAfter).toContain(`"${id}"`)
  })
})
