// 移动版数据层测试：全部跑在内存 FileStore 上，不需要真机。
//
// 重点不是「函数返回了什么」，而是**两条链必须互为逆运算**：
//   写路径（内存先行 → 追加落盘）之后 reload()（读文件 → 重放）得到的内存态，
//   必须与写路径当场得到的内存态逐字段一致。
// 这是跨机同步的正确性前提——手机写的行，桌面端重放后必须看到同样的调度状态。
import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryFileStore } from './fs'
import { MobilePaths } from './paths'
import { MobileWorkspace } from './workspace'
import type { Card } from '@shared/types'

const ROOT = 'miki-base'

/** 当前月份的 review-log 文件路径（用 MobilePaths 自己算，避免 UTC/本地月份不一致） */
const logFile = (): string => new MobilePaths(ROOT).logFile(Date.now())

/** 铺一个最小工作区：1 个牌组 + 2 张新卡 */
function seedWorkspace(fs: MemoryFileStore): void {
  fs.seed(
    `${ROOT}/decks.json`,
    JSON.stringify([{ id: 'd1', name: '测试牌组', order: 0, createdAt: 1_700_000_000_000, deletedAt: null }], null, 2)
  )
  const rows = [
    {
      id: 'c1',
      front: '第一张',
      back: '答案一',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      deletedAt: null,
      suspended: false
    },
    {
      id: 'c2',
      front: '第二张',
      back: '答案二',
      createdAt: 1_700_000_001_000,
      updatedAt: 1_700_000_001_000,
      deletedAt: null,
      suspended: false
    }
  ]
  fs.seed(`${ROOT}/cards/d1.ndjson`, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

async function openWorkspace(fs: MemoryFileStore): Promise<MobileWorkspace> {
  const ws = new MobileWorkspace(fs, new MobilePaths(ROOT))
  await ws.init()
  return ws
}

/** 取某文件内容（不存在返回空串），断言落盘用 */
async function read(fs: MemoryFileStore, path: string): Promise<string> {
  return (await fs.readText(path)) ?? ''
}

/** 只比较「真理字段」：内存态里 tie/seqApplied 是运行期索引字段，重载后本来就会重算 */
function truth(c: Card | null): unknown {
  if (!c) return null
  return {
    id: c.id,
    deckId: c.deckId,
    front: c.front,
    back: c.back,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    deletedAt: c.deletedAt,
    suspended: c.suspended,
    fsrs: c.fsrs,
    reps: c.reps,
    lapses: c.lapses
  }
}

describe('移动版工作区：加载链', () => {
  let fs: MemoryFileStore
  beforeEach(() => {
    fs = new MemoryFileStore()
    seedWorkspace(fs)
  })

  it('读 decks.json 与卡片基文件，新卡计入 new', async () => {
    const ws = await openWorkspace(fs)
    expect(ws.decks.map((d) => d.name)).toEqual(['测试牌组'])
    expect(ws.cards.size).toBe(2)
    expect(ws.deckInfos()).toEqual([
      {
        id: 'd1',
        name: '测试牌组',
        order: 0,
        createdAt: 1_700_000_000_000,
        deletedAt: null,
        counts: { total: 2, new: 2, due: 0 }
      }
    ])
  })

  it('config.json 缺失时用默认值，且绝不写回工作区', async () => {
    const ws = await openWorkspace(fs)
    expect(ws.config.leechThreshold).toBe(8)
    expect(ws.config.workspacePath).toBe(ROOT)
    expect(await fs.readText(`${ROOT}/config.json`)).toBeNull()
    expect(fs.calls.some((c) => c.startsWith('write:') || c.startsWith('append:'))).toBe(false)
  })

  it('config.json 存在时读它的学习参数（移动端只读不写）', async () => {
    fs.seed(`${ROOT}/config.json`, JSON.stringify({ desiredRetention: 0.85, leechThreshold: 3 }))
    const ws = await openWorkspace(fs)
    expect(ws.config.desiredRetention).toBe(0.85)
    expect(ws.config.leechThreshold).toBe(3)
  })

  it('坏行被记账而不是静默丢弃', async () => {
    fs.seed(`${ROOT}/cards/d1.ndjson`, '{"id":"c9"}\n{坏行}\n')
    const ws = await openWorkspace(fs)
    const rep = ws.damageReport()
    expect(rep.damagedLines).toBe(1)
    expect(rep.files).toContain('cards/d1.ndjson')
    expect(ws.cards.size).toBe(1)
  })
})

describe('移动版工作区：写入 → 重载 的往返一致性', () => {
  let fs: MemoryFileStore
  let ws: MobileWorkspace
  beforeEach(async () => {
    fs = new MemoryFileStore()
    seedWorkspace(fs)
    ws = await openWorkspace(fs)
  })

  it('答题：review-log 追加一行，重载后调度状态完全一致', async () => {
    const before = ws.getStudy('d1')
    expect(before.card).not.toBeNull()
    const cardId = before.card!.id

    const after = await ws.answer(cardId, 3, 1234)
    expect(after.answeredCardId).toBe(cardId)
    expect(after.todayCount).toBe(1)

    const log = await read(fs, logFile())
    const ev = JSON.parse(log.trim())
    expect(ev).toMatchObject({ action: 'answer', cardId, deckId: 'd1', rating: 3, durationMs: 1234 })
    expect(ev.before).toBeNull()
    expect(ev.after).toBeTruthy()

    const inMemory = truth(ws.getCard(cardId))
    const ws2 = await openWorkspace(fs)
    expect(truth(ws2.getCard(cardId))).toEqual(inMemory)
    expect(ws2.todayCount()).toBe(1)
    expect(ws2.totalAnswered()).toBe(1)
  })

  it('撤销：追加 undo 事件，重载后回到答题前状态', async () => {
    const cardId = ws.getStudy('d1').card!.id
    const beforeAnswer = truth(ws.getCard(cardId))

    await ws.answer(cardId, 4)
    const undone = await ws.undo()
    expect(undone.restoredCardId).toBe(cardId)
    expect(undone.todayCount).toBe(0)

    const ws2 = await openWorkspace(fs)
    expect(truth(ws2.getCard(cardId))).toEqual(beforeAnswer)
    expect(ws2.todayCount()).toBe(0)
    expect(ws2.totalAnswered()).toBe(0)
    // undo 事件自带 targetAction/targetRating（跨端重放靠它们，不靠内存里的撤销栈）
    const log = await read(fs, logFile())
    const evs = log
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(evs).toHaveLength(2)
    expect(evs[1]).toMatchObject({ action: 'undo', targetAction: 'answer', targetRating: 4 })
  })

  it('新增卡片：追加基文件；重载后仍在且是 new', async () => {
    const card = await ws.addCard('d1', '新卡面', '新卡背')
    const base = await read(fs, `${ROOT}/cards/d1.ndjson`)
    const lines = base.trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[2])).toMatchObject({ id: card.id, front: '新卡面', back: '新卡背' })
    // 内容行不含调度字段
    expect(JSON.parse(lines[2]).fsrs).toBeUndefined()

    const ws2 = await openWorkspace(fs)
    expect(truth(ws2.getCard(card.id))).toEqual(truth(ws.getCard(card.id)))
    expect(ws2.deckInfos()[0].counts.new).toBe(3)
  })

  it('编辑卡片：追加 delta 且只写内容字段；重载后新内容生效', async () => {
    await ws.answer('c1', 3)
    const withSchedule = truth(ws.getCard('c1'))!
    await ws.updateCard('c1', { front: '改过的正面' })

    const delta = await read(fs, `${ROOT}/cards/d1.delta.ndjson`)
    const row = JSON.parse(delta.trim())
    expect(row).toMatchObject({ id: 'c1', front: '改过的正面' })
    expect(row.fsrs).toBeUndefined() // 内容变更行不带调度快照，继承基行
    expect(row.__mikiSeq).toBeUndefined() // 也不带水位

    const ws2 = await openWorkspace(fs)
    const reloaded = truth(ws2.getCard('c1'))!
    expect((reloaded as { front: string }).front).toBe('改过的正面')
    // 调度状态必须原样保留（delta 行继承基行的 fsrs）
    expect((reloaded as { fsrs: unknown }).fsrs).toEqual((withSchedule as { fsrs: unknown }).fsrs)
    expect((reloaded as { reps: number }).reps).toBe(1)
  })

  it('乐观锁：updatedAt 对不上时报冲突且不写盘', async () => {
    const stale = ws.getCard('c1')!.updatedAt
    await ws.updateCard('c1', { front: '别人先改的' })
    const deltaBefore = await read(fs, `${ROOT}/cards/d1.delta.ndjson`)

    const res = await ws.updateCardChecked('c1', { front: '我用旧版本覆盖' }, stale)
    expect(res.status).toBe('conflict')
    expect(await read(fs, `${ROOT}/cards/d1.delta.ndjson`)).toBe(deltaBefore)

    const ok = await ws.updateCardChecked('c1', { front: '基于最新版本' }, ws.getCard('c1')!.updatedAt)
    expect(ok.status).toBe('ok')
  })

  it('删除卡片：只追加 review-log，不碰卡片文件；重载后从牌组消失', async () => {
    const baseBefore = await read(fs, `${ROOT}/cards/d1.ndjson`)
    const deltaBefore = await read(fs, `${ROOT}/cards/d1.delta.ndjson`)
    await ws.deleteCard('c2')

    expect(await read(fs, `${ROOT}/cards/d1.ndjson`)).toBe(baseBefore)
    expect(await read(fs, `${ROOT}/cards/d1.delta.ndjson`)).toBe(deltaBefore)

    const ws2 = await openWorkspace(fs)
    expect(ws2.cards.get('c2')!.deletedAt).toBeTruthy()
    expect(ws2.deckInfos()[0].counts.total).toBe(1)
    // 撤销删除：只有本会话能撤（重启后撤销栈为空，这是有意的）
    const undone = await ws.undo()
    expect(undone.restoredCardId).toBe('c2')
    expect(ws.getCard('c2')!.deletedAt).toBeNull()
  })

  it('暂停/解除：走 suspend 事件，重载后 due 计数同步变化', async () => {
    await ws.setCardSuspended('c1', true)
    const ws2 = await openWorkspace(fs)
    expect(ws2.getCard('c1')!.suspended).toBe(true)
    expect(ws2.deckInfos()[0].counts.new).toBe(1)
  })

  it('leech 自动暂停：重来次数达阈值时一并写入 suspend 事件', async () => {
    const ws3 = new MobileWorkspace(fs, new MobilePaths(ROOT))
    await ws3.init()
    ws3.config = { ...ws3.config, leechThreshold: 1 }
    await ws3.answer('c1', 1)

    const log = await read(fs, logFile())
    const evs = log
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(evs.map((e) => e.action)).toEqual(['answer', 'suspend'])

    const ws4 = await openWorkspace(fs)
    expect(ws4.getCard('c1')!.suspended).toBe(true)
    expect(ws4.getCard('c1')!.lapses).toBe(1)
  })

  it('新增牌组：decks.json 整份重写，重载后可见', async () => {
    const deck = await ws.addDeck('新牌组')
    const ws2 = await openWorkspace(fs)
    expect(ws2.decks.map((d) => d.name)).toEqual(['测试牌组', '新牌组'])
    expect(ws2.deckInfos()[1].id).toBe(deck.id)
  })

  it('queryCards 与 getStats 在移动端也能用（纯 core 复用）', async () => {
    await ws.answer('c1', 3)
    const q = ws.queryCards({ deckId: 'd1', keywords: [], sort: [{ col: 'createdAt', asc: true }] })
    expect(q.total).toBe(2)
    expect(q.rows[0].front).toBe('第一张')
    const stats = ws.getStats({ deckId: null, range: 'year' })
    expect(stats.retention.total).toBe(1)
    expect(ws.todayCount()).toBe(1)
  })

  it('评级预览给出四档 due，且关掉 fuzz 后重复调用稳定', async () => {
    const a = ws.previewIntervals('c1')
    const b = ws.previewIntervals('c1')
    expect(a).toHaveLength(4)
    expect(a).toEqual(b)
    expect(a[0]).toBeLessThan(a[3])
  })

  it('软删牌组：其下卡片不进首页/卡片库（与桌面端 hiddenDeckIds 同口径）', async () => {
    const fs2 = new MemoryFileStore()
    fs2.seed(
      `${ROOT}/decks.json`,
      JSON.stringify([
        { id: 'd1', name: '在用的', order: 0, createdAt: 1, deletedAt: null },
        { id: 'd9', name: '已删的', order: 1, createdAt: 2, deletedAt: 3 }
      ])
    )
    const row = (id: string, t: number): string =>
      JSON.stringify({ id, front: id, back: id, createdAt: t, updatedAt: t, deletedAt: null, suspended: false })
    fs2.seed(`${ROOT}/cards/d1.ndjson`, row('a1', 1) + '\n')
    fs2.seed(`${ROOT}/cards/d9.ndjson`, row('b1', 2) + '\n')

    const w = await openWorkspace(fs2)
    expect(w.deckInfos().map((d) => d.id)).toEqual(['d1'])
    expect(w.queryCards({ deckId: null, keywords: [], sort: [] }).total).toBe(1)
    // 卡片本身还在内存里（重放不丢），只是查询口径排除
    expect(w.cards.size).toBe(2)
  })
})
