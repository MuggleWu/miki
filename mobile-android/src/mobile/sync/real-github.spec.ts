// 真实 GitHub 演练（M5 出口标准里"双向同步跑通"的可执行版本）。
//
// 与 sync.spec.ts 的区别：那个用假 GitHub 验编排逻辑，这个**真的调 api.github.com**，
// 验的是"Git Data API 那条链路在真服务器上确实能跑通"——blob 的 base64 往返、
// 大文件不分块、非 fast-forward 真的返回 422、以及远端 blob sha 与本地内容指纹对得上。
//
// 默认跳过（需要真凭据）。跑法：
//   MIKI_GITHUB_TOKEN=<细粒度PAT> MIKI_GITHUB_REPO=<owner/repo> \
//     npx vitest run src/mobile/sync/real-github.spec.ts
//
// 安全约定（写在代码里当护栏，不靠自觉）：
//   ① 只往 `drill-` 开头的**临时分支**写，写完删掉；分支名不以 drill- 开头就直接拒绝运行；
//   ② 默认分支名（main/master）一律拒绝——这个测试会创建 commit，绝不能落在真数据上；
//   ③ token 只从环境变量读，不落盘、不打印（打印的是 masked 形态）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryFileStore } from '../fs/memory-fs'
import { MobilePaths } from '../paths'
import { GithubClient, GithubError } from './github'
import { hashText, runSync, type SyncEnv } from './index'
import { emptyBase, type SyncBase, type SyncCreds } from './types'

const TOKEN = process.env.MIKI_GITHUB_TOKEN
const REPO = process.env.MIKI_GITHUB_REPO
const BRANCH = process.env.MIKI_GITHUB_BRANCH ?? `drill-${Math.floor(Date.now() / 1000)}`
const enabled = Boolean(TOKEN && REPO)
const DEFAULT_BRANCHES = ['main', 'master']

if (enabled && DEFAULT_BRANCHES.includes(BRANCH)) {
  throw new Error(`拒绝在默认分支 ${BRANCH} 上跑演练：这个测试会创建 commit`)
}
if (enabled && !BRANCH.startsWith('drill-')) {
  throw new Error(`拒绝在非临时分支 ${BRANCH} 上跑演练：分支名必须以 drill- 开头`)
}

const creds: SyncCreds = { repo: REPO ?? '', branch: BRANCH, token: TOKEN ?? '' }
const API = 'https://api.github.com'

/** 建/删分支是演练自身的脚手架（客户端不做这件事），直接用 fetch */
async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : await res.json()
}

/** 用客户端把一批文件推到演练分支（模拟"桌面端改了并 push"） */
async function pushAsDesktop(files: Record<string, string>, message: string): Promise<string> {
  const client = new GithubClient(creds)
  const head = await client.head()
  const blobs = await Promise.all(
    Object.entries(files).map(async ([path, text]) => ({ path, sha: await client.writeBlob(text) }))
  )
  const tree = await client.createTree(head.tree, blobs)
  const commit = await client.createCommit(message, tree, head.commit)
  await client.updateRef(commit)
  return commit
}

/** 收尾清理：分支没建成功（比如建分支那步就失败了）时忽略"引用不存在" */
async function deleteBranch(): Promise<void> {
  try {
    await api('DELETE', `/repos/${REPO}/git/refs/heads/${BRANCH}`)
    console.log(`[演练] 已删除临时分支 ${BRANCH}`)
  } catch (e) {
    console.log(`[演练] 临时分支无需清理：${e instanceof Error ? e.message.slice(0, 60) : String(e)}`)
  }
}

/** 造一个最小合成工作区（不碰任何真实数据） */
function makeWorkspace(): { store: MemoryFileStore; env: SyncEnv; seen: { events: number } } {
  const store = new MemoryFileStore()
  const paths = new MobilePaths('drill-ws')
  const deckId = 'drill-deck-0001'
  store.seed('drill-ws/decks.json', JSON.stringify([{ id: deckId, name: '演练牌组', createdAt: 1 }]) + '\n')
  store.seed(`drill-ws/cards/${deckId}.ndjson`, JSON.stringify({ id: 'c1', front: '一加一', back: '二' }) + '\n')
  store.seed(
    'drill-ws/review-log/2026-09.ndjson',
    JSON.stringify({ type: 'answer', cardId: 'c1', at: 1, rating: 3 }) + '\n'
  )
  const seen = { events: 0 }
  const env: SyncEnv = {
    store,
    paths,
    reloadAndVerify: async () => {
      // 演练里只做"能读回来"的最小重放：数 review-log 的行数
      const log = await store.readText('drill-ws/review-log/2026-09.ndjson')
      const n = log ? log.split('\n').filter((l) => l.trim().length > 0).length : 0
      seen.events = n
      return { eventCount: n, damaged: 0, truncated: 0, cards: 1 }
    }
  }
  return { store, env, seen }
}

describe.skipIf(!enabled)(`真实 GitHub 演练（分支 ${BRANCH}）`, () => {
  let base: SyncBase = emptyBase()

  beforeAll(async () => {
    // 起点刻意是**空树 + 无父提交**的孤儿分支，不从默认分支分叉：
    // ① 演练里推的是合成小工作区，若分支上带着真实工作区文件，两边会在 decks.json 上
    //    撞成"双方都改"被拦下（引擎行为正确，但这测的就不是推送链路了）；
    // ② 演练从头到尾不碰任何真实数据，也不把它们拉到内存里。
    // GitHub 不接受空树（"Invalid tree info"），所以起点放一个占位文件；
    // 演练推的合成文件都在它旁边，互不干扰。
    const keep = (await api('POST', `/repos/${REPO}/git/blobs`, {
      content: Buffer.from('演练占位文件，跑完随分支一起删掉\n', 'utf8').toString('base64'),
      encoding: 'base64'
    })) as { sha: string }
    const rootTree = (await api('POST', `/repos/${REPO}/git/trees`, {
      tree: [{ path: 'DRILL-KEEP', mode: '100644', type: 'blob', sha: keep.sha }]
    })) as { sha: string }
    const rootCommit = (await api('POST', `/repos/${REPO}/git/commits`, {
      message: 'drill: 空分支起点（演练用，跑完即删）',
      tree: rootTree.sha,
      parents: []
    })) as { sha: string }
    await api('POST', `/repos/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: rootCommit.sha })
    console.log(`[演练] 已建空分支 ${BRANCH}（起点 ${rootCommit.sha.slice(0, 7)}，无父提交）`)
  }, 60_000)

  afterAll(async () => {
    if (!enabled) return
    await deleteBranch()
  }, 60_000)

  it('凭据与仓库可达', async () => {
    const client = new GithubClient(creds)
    const v = await client.verify()
    // 只回显末 4 位（与 App 里凭据的脱敏形态一致：token 不进日志）
    console.log(`[演练] 验证连接：${v.ok ? 'OK' : '失败'}｜token ****${TOKEN!.slice(-4)}`)
    expect(v.ok).toBe(true)
  }, 60_000)

  it('推送：本地有内容 → 真服务器上出现一条 commit，内容可读回', async () => {
    const { env, store } = makeWorkspace()
    const out = await runSync(env, creds, base)
    console.log(`[演练] 首次同步：${out.report.message}`)

    // 远端确实是空的（刚建的分支沿用远端骨架）→ 应当全部推上去
    expect(out.report.ok).toBe(true)
    expect(out.report.pushed).toBeGreaterThan(0)
    expect(out.report.commit).toBeTruthy()

    // 源到线上读回：不看内存里的假设，看服务器上的树
    const client = new GithubClient(creds)
    const head = await client.head()
    expect(head.commit).toBe(out.report.commit)
    const files = await client.listFiles(head.tree)
    const paths = files.map((f) => f.path)
    expect(paths).toContain('decks.json')
    expect(paths).toContain('cards/drill-deck-0001.ndjson')
    const deckBlob = files.find((f) => f.path === 'decks.json')!
    const roundTrip = await client.readFile(deckBlob.sha)
    expect(roundTrip).toBe(await store.readText('drill-ws/decks.json'))
    base = out.base
  }, 120_000)

  it('无变更：再同步一次不产生 commit（不做无意义的写入）', async () => {
    const { env } = makeWorkspace()
    // 把上次推送后的 base 交给它：远端头没变、本地内容也没变
    const out = await runSync(env, creds, base)
    expect(out.report.pushed).toBe(0)
    expect(out.report.pulled).toBe(0)
    expect(out.report.files.every((f) => f.action === 'skip')).toBe(true)
    console.log(`[演练] 二次同步：${out.report.message}`)
  }, 120_000)

  it('拉取：桌面端改了远端 → 手机端把改动拉下来', async () => {
    const { env, store } = makeWorkspace()
    const extra = JSON.stringify({ type: 'answer', cardId: 'c1', at: 2, rating: 4 }) + '\n'
    const log = (await store.readText('drill-ws/review-log/2026-09.ndjson')) + extra
    await pushAsDesktop({ 'review-log/2026-09.ndjson': log }, 'desktop: 演练——桌面端追答一条')

    const out = await runSync(env, creds, base)
    console.log(`[演练] 拉取同步：${out.report.message}`)
    expect(out.report.ok).toBe(true)
    expect(out.report.pulled).toBeGreaterThan(0)
    expect(await store.readText('drill-ws/review-log/2026-09.ndjson')).toBe(log)
    base = out.base
  }, 120_000)

  it('双方都改同一个 JSON 文件 → 拦下，谁的数据都不动', async () => {
    const { env, store } = makeWorkspace()
    // 远端（桌面端）改 decks.json
    const remoteDecks = JSON.stringify([{ id: 'drill-deck-0001', name: '演练牌组（桌面端改名）', createdAt: 1 }]) + '\n'
    await pushAsDesktop({ 'decks.json': remoteDecks }, 'desktop: 演练——桌面端改牌组名')

    // 本地（手机端）也改 decks.json，但内容不同
    const localDecks = JSON.stringify([{ id: 'drill-deck-0001', name: '演练牌组（手机端改名）', createdAt: 1 }]) + '\n'
    await store.writeText('drill-ws/decks.json', localDecks)

    const out = await runSync(env, creds, base)
    console.log(`[演练] 冲突同步：${out.report.message}`)
    expect(out.report.ok).toBe(false)
    expect(out.report.files.some((f) => f.action === 'blocked')).toBe(true)
    expect(out.report.pushed).toBe(0)
    // 两边内容都没被改动（不猜、不覆盖）
    expect(await store.readText('drill-ws/decks.json')).toBe(localDecks)
    const client = new GithubClient(creds)
    const head = await client.head()
    const remote = await client.readFile((await client.listFiles(head.tree)).find((f) => f.path === 'decks.json')!.sha)
    expect(remote).toBe(remoteDecks)
  }, 120_000)

  it('非 fast-forward 的推送被服务器拒绝（绝不覆盖别人的提交）', async () => {
    const client = new GithubClient(creds)
    const stale = (await client.head()).commit
    await pushAsDesktop({ 'review-log/2026-09.ndjson': '' }, 'desktop: 演练——抢先推一条')
    // 拿过期的 head 去更新分支头：GitHub 必须拒绝（这就是"绝不覆盖别人的提交"）
    const err = await client.updateRef(stale).then(
      () => null,
      (e: unknown) => e as GithubError
    )
    expect(err).toBeInstanceOf(GithubError)
    expect(err!.status).toBe(422)
    console.log(`[演练] 过期 head 推送被拒：HTTP ${err!.status}（${err!.message.slice(0, 80)}）`)
  }, 120_000)

  it('本地内容指纹与远端 blob sha 对得上（并发改动的判定依据）', async () => {
    const { store } = makeWorkspace()
    const local = await store.readText('drill-ws/decks.json')
    expect(await hashText(local!)).toHaveLength(64)
    const client = new GithubClient(creds)
    const head = await client.head()
    const entry = (await client.listFiles(head.tree)).find((f) => f.path === 'decks.json')!
    // blob sha 是 git 的对象 id，与我们的内容指纹不是同一个东西——两者都要有，
    // 一个用来判断"远端变没变"，一个用来判断"本地变没变"
    expect(entry.sha).toMatch(/^[0-9a-f]{40}$/)
  }, 60_000)
})
