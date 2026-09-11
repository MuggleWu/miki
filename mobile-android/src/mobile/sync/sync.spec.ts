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

  /** 远端删除（模拟桌面端压实后 rmSync 掉 delta） */
  remove(path: string): void {
    this.files.delete(path)
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

describe('远端删除的可见性', () => {
  it('远端删掉一个文件后不再当成「两侧都没改」：本机副本保留，也不会被推回去', async () => {
    // 桌面端压实会删掉 delta 文件；手机端此前用 `?? baseRemoteSha` 兜底把它读成
    // 「远端有这个文件且没变」，于是永远留着它，本机之后一改还会把它推回去。
    gh.push('decks.json', '[{"id":"d1","name":"A"}]')
    gh.push('cards/d1.delta.ndjson', row({ id: 'c1', front: '改过' }))
    const store = new MemoryFileStore()
    const env = { store, paths, reloadAndVerify: verifyFrom(store) }
    const first = await runSync(env, creds, emptyBase(), 'full')
    expect(first.report.pulled).toBe(2)

    gh.remove('cards/d1.delta.ndjson')
    const refUpdatesBefore = gh.refUpdates
    const second = await runSync(env, creds, first.base, 'full')
    const entry = second.report.files.find((f) => f.path === 'cards/d1.delta.ndjson')
    expect(entry?.action).toBe('skip')
    expect(entry?.reason).toContain('远端已删除')
    // 保守：不自动删本机文件（内容还在本机，用户可自行处理）
    expect(await store.readText(`${ROOT}/cards/d1.delta.ndjson`)).not.toBeNull()
    // 本机没改 → 不产生 commit（修之前这里会把它当成「只本地有」推回远端）
    expect(gh.refUpdates).toBe(refUpdatesBefore)
    expect(second.report.pushed).toBe(0)
  })
})

describe('快照时机', () => {
  it('快照拍在合并落地之前：里面是「合并前」的本地内容，不是合并后的', async () => {
    // 修之前快照在推送段才拍 —— 那时合并结果已经写进工作区，"安全网"拍到的是改完的状态，
    // 真合并坏了根本退不回去；写入阶段抛错时更是连快照都没有。
    gh.push('cards/d1.ndjson', row({ id: 'r1', front: '远端的行' }))
    const store = new MemoryFileStore()
    const env = { store, paths, reloadAndVerify: verifyFrom(store) }
    const first = await runSync(env, creds, emptyBase(), 'full')
    expect(first.report.pulled).toBe(1)

    // 本机加一行（本机改了）、远端也加一行（远端改了）→ union：两者都要保留，且要推
    const localBefore = row({ id: 'l1', front: '本机的行' })
    await store.writeText(`${ROOT}/cards/d1.ndjson`, (await store.readText(`${ROOT}/cards/d1.ndjson`))! + localBefore)
    gh.push('cards/d1.ndjson', row({ id: 'r1', front: '远端的行' }) + row({ id: 'r2', front: '远端新行' }))

    const textBeforeMerge = (await store.readText(`${ROOT}/cards/d1.ndjson`))!
    const second = await runSync(env, creds, first.base, 'full')
    expect(second.report.pushed).toBe(1)
    expect(second.report.snapshot).toBeTruthy()

    const merged = (await store.readText(`${ROOT}/cards/d1.ndjson`))!
    expect(merged).toContain('远端新行')
    expect(merged).toContain('本机的行')

    const snap = (await store.readText(`${ROOT}-backups/${second.report.snapshot}/cards/d1.ndjson`))!
    expect(snap).toBe(textBeforeMerge)
    expect(snap).not.toContain('远端新行')
    // 带毫秒：同一秒内的两次同步不能写进同一个目录
    expect(second.report.snapshot!.length).toBeGreaterThan(20)
  })
})

describe('blocked 的文件级粒度', () => {
  it('一个分叉文件只跳过它自己：答题进度照推，且它不会被记成「已同步」', async () => {
    gh.push('decks.json', '[{"id":"a","name":"旧"}]')
    const store = new MemoryFileStore()
    const env = { store, paths, reloadAndVerify: verifyFrom(store) }
    const first = await runSync(env, creds, emptyBase(), 'full')
    expect(first.report.pulled).toBe(1) // decks.json 第一次是直接拉下来

    // 两侧各自改 decks.json（JSON 不能按行拼 → blocked），同时本机还有新的答题记录要推
    await store.writeText(`${ROOT}/decks.json`, '[{"id":"a","name":"本机改的"}]')
    gh.push('decks.json', '[{"id":"a","name":"远端改的"}]')
    await store.writeText(`${ROOT}/review-log/2026-09.ndjson`, row({ id: 'r1', cardId: 'a', rating: 3 }))

    const before = gh.refUpdates
    const second = await runSync(env, creds, first.base, 'full')
    // 修之前：整次停止（ok=false、什么都没推），本机的答题进度一直备不上去
    expect(second.report.ok).toBe(true)
    expect(gh.refUpdates).toBe(before + 1)
    expect(second.report.pushed).toBe(1)
    expect(second.report.message).toContain('不能自动合并')
    const blocked = second.report.files.find((f) => f.path === 'decks.json')
    expect(blocked?.action).toBe('blocked')
    // 本机那份保持原样（没被远端盖掉，也没被推上去）
    expect(await store.readText(`${ROOT}/decks.json`)).toBe('[{"id":"a","name":"本机改的"}]')
    // 关键：分叉文件必须记进 conflicts，否则下次同步在记账看是"两侧都没变"
    // （甚至被读成"本地新建的文件"→ 把本机那份推上去盖掉远端），分叉永远不收敛
    expect(second.base.conflicts).toEqual(['decks.json'])
  })

  it('被跳过的分叉文件下次同步仍会被判为 blocked（不会静默变成「已同步」）', async () => {
    gh.push('decks.json', '[{"id":"a","name":"旧"}]')
    const store = new MemoryFileStore()
    const env = { store, paths, reloadAndVerify: verifyFrom(store) }
    const first = await runSync(env, creds, emptyBase(), 'full')
    await store.writeText(`${ROOT}/decks.json`, '[{"id":"a","name":"本机改的"}]')
    gh.push('decks.json', '[{"id":"a","name":"远端改的"}]')

    const second = await runSync(env, creds, first.base, 'full')
    const third = await runSync(env, creds, second.base, 'full')
    expect(third.report.files.find((f) => f.path === 'decks.json')?.action).toBe('blocked')
  })
})

describe('用远端覆盖本机（force-pull）', () => {
  const corrupt = '[{"id":"a","name":"半写'

  it('点名覆盖：本机读不出来的那份被远端盖掉，不产生 commit，记账随之对齐', async () => {
    // 这条路径是用来解死局的：本机 decks.json 读不出来时，之前的同步只会在"只本地改了"
    // 与 blocked 之间来回，本机那份永远救不回来。
    gh.push('decks.json', '[{"id":"a","name":"远端的"}]')
    const store = new MemoryFileStore()
    const env = { store, paths, reloadAndVerify: verifyFrom(store) }
    await store.writeText(`${ROOT}/decks.json`, corrupt)
    await store.writeText(`${ROOT}/review-log/2026-09.ndjson`, row({ id: 'r1', cardId: 'a', rating: 3 }))

    const before = gh.refUpdates
    const out = await runSync(env, creds, emptyBase(), 'force-pull', { forcePaths: ['decks.json'] })
    expect(out.report.pulled).toBe(1)
    expect(out.report.pushed).toBe(0)
    expect(gh.refUpdates).toBe(before) // 只拉不推
    expect(await store.readText(`${ROOT}/decks.json`)).toBe('[{"id":"a","name":"远端的"}]')
    // 没点名的文件一根手指都不碰（答题记录还在）
    expect(await store.readText(`${ROOT}/review-log/2026-09.ndjson`)).toContain('r1')
    // 记账对齐：这个文件以后不再被判为"只本地改了"
    expect(out.base.remoteSha['decks.json']).toBeTruthy()
    expect(out.base.localHash['decks.json']).toBeTruthy()
    expect(out.base.commit).toBeNull() // 记账的 commit 不推进（远端其余文件这次并没被消费）
  })

  it('远端没有这个文件 → 报告而不是删本机文件', async () => {
    const store = new MemoryFileStore()
    const env = { store, paths, reloadAndVerify: verifyFrom(store) }
    await store.writeText(`${ROOT}/cards/d9.ndjson`, row({ id: 'x' }))
    const out = await runSync(env, creds, emptyBase(), 'force-pull', { forcePaths: ['cards/d9.ndjson'] })
    expect(out.report.pulled).toBe(0)
    expect(out.report.files[0].reason).toContain('远端没有这个文件')
    expect(await store.readText(`${ROOT}/cards/d9.ndjson`)).not.toBeNull()
  })

  it('远端那份也不是合法 JSON → 拒绝覆盖（别把坏文件换个来源）', async () => {
    gh.push('decks.json', '{坏的')
    const store = new MemoryFileStore()
    const env = { store, paths, reloadAndVerify: verifyFrom(store) }
    await store.writeText(`${ROOT}/decks.json`, '[{"id":"本机的"}]')
    const out = await runSync(env, creds, emptyBase(), 'force-pull', { forcePaths: ['decks.json'] })
    expect(out.report.pulled).toBe(0)
    expect(out.report.files[0].reason).toContain('不是合法 JSON')
    expect(await store.readText(`${ROOT}/decks.json`)).toBe('[{"id":"本机的"}]')
  })

  it('没点名任何文件 → 直接报错（这是个调用错误，不是"什么都不做"）', async () => {
    const store = new MemoryFileStore()
    const env = { store, paths, reloadAndVerify: verifyFrom(store) }
    await expect(runSync(env, creds, emptyBase(), 'force-pull', {})).rejects.toThrow('没有点名任何文件')
  })
})

describe('同步路径白名单', () => {
  it('远端树里的任意 .ndjson 不会在本机建出目录（路径是输入，不是指令）', async () => {
    gh.push('foo/evil.ndjson', row({ id: 'x' }))
    gh.push('cards/a/b.ndjson', row({ id: 'y' }))
    gh.push('cards/good.ndjson', row({ id: 'z' }))
    gh.push('stats.json', '{"派生缓存":true}')
    const store = new MemoryFileStore()
    const out = await runSync({ store, paths, reloadAndVerify: verifyFrom(store) }, creds, emptyBase(), 'full')
    expect(out.report.pulled).toBe(1) // 只有 cards/good.ndjson
    expect(await store.readText(`${ROOT}/foo/evil.ndjson`)).toBeNull()
    expect(await store.readText(`${ROOT}/cards/a/b.ndjson`)).toBeNull()
    expect(await store.readText(`${ROOT}/stats.json`)).toBeNull()
    expect(await store.readText(`${ROOT}/cards/good.ndjson`)).not.toBeNull()
  })

  it('本地 cards/ 下的一层 .ndjson 照常参与（白名单不能误伤自己）', async () => {
    const store = new MemoryFileStore()
    await store.writeText(`${ROOT}/cards/d1.ndjson`, row({ id: 'c1' }))
    await store.writeText(`${ROOT}/review-log/2026-09.ndjson`, row({ id: 'r1' }))
    const out = await runSync({ store, paths, reloadAndVerify: verifyFrom(store) }, creds, emptyBase(), 'full')
    expect(out.report.pushed).toBe(2)
  })
})
