// 调度索引对拍：随机操作序列下，最小堆 + 计数器的结果必须与全量扫描（core/queue）严格一致。
// 索引是性能优化（需求 §19 L1），对拍保证它只是实现替换、语义零变化。
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { WorkspaceService } from '../workspace'
import { pickNext, remainingCount } from '../../core/queue'
import type { Card, Rating } from '../../shared/types'

const dirs: string[] = []
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'miki-idx-test-'))
  dirs.push(d)
  return d
}
const newWs = (d: string) => {
  const w = new WorkspaceService()
  w.init(d)
  return w
}
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

/** 基准：与 workspace.deckCards 同口径的全量过滤 */
function refCards(w: WorkspaceService, deckId: string): Card[] {
  const hidden = new Set(w.decks.filter((d) => d.deletedAt).map((d) => d.id))
  const out: Card[] = []
  for (const c of w.cards.values()) {
    if (c.deletedAt || hidden.has(c.deckId)) continue
    if (c.deckId !== deckId) continue
    out.push(c)
  }
  return out
}

/** 对拍：学习页取卡/剩余 + 首页三列计数，全牌组逐一核对 */
/** 首页三列参考口径：总数=未删卡（含暂停）；未学习=新卡；到期=此刻已到期的学习/复习卡 */
function refTableCounts(list: Card[], now: number): { total: number; new: number; due: number } {
  let total = 0
  let nw = 0
  let due = 0
  for (const c of list) {
    if (c.deletedAt) continue
    total++
    if (c.suspended) continue
    if (!c.fsrs) nw++
    else if (c.fsrs.due <= now) due++
  }
  return { total, new: nw, due }
}

function assertIndexMatchesScan(w: WorkspaceService): void {
  const now = Date.now()
  const eot = w.endOfToday()
  for (const deck of w.decks) {
    const list = refCards(w, deck.id)
    const study = w.getStudy(deck.id)
    const refCard = pickNext(list, now, eot)
    expect(study.card?.id ?? null, `pickNext mismatch deck=${deck.name}`).toBe(refCard?.id ?? null)
    expect(study.remaining, `remaining mismatch deck=${deck.name}`).toBe(remainingCount(list, eot))
    const info = w.deckInfos().find((x) => x.id === deck.id)
    expect(info).toBeDefined()
    expect(info!.counts, `deckCounts mismatch deck=${deck.name}`).toEqual(refTableCounts(list, now))
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('调度索引随机对拍', () => {
  it('随机混合操作 200 步，索引与全量扫描逐步一致，重启后仍一致', () => {
    const rng = mulberry32(20260906)
    const w = newWs(tmp())
    const d1 = w.addDeck('对拍一').id
    const d2 = w.addDeck('对拍二').id
    const decks = [d1, d2]
    const pool: string[] = [] // 全部未删卡
    const ratings: Rating[] = [1, 2, 3, 4]

    for (let step = 0; step < 200; step++) {
      const r = rng()
      if (r < 0.28 || pool.length < 3) {
        const deck = decks[Math.floor(rng() * decks.length)]
        const n = 1 + Math.floor(rng() * 3)
        const added = w.addCards(
          deck,
          Array.from({ length: n }, (_, i) => ({ front: `卡${step}-${i}`, back: '' }))
        )
        pool.push(...added.map((c) => c.id))
      } else if (r < 0.55) {
        const id = pool[Math.floor(rng() * pool.length)]
        const card = w.getCard(id)!
        if (!card.deletedAt) w.answer(id, ratings[Math.floor(rng() * 4)], 1000)
      } else if (r < 0.68) {
        w.undo()
        for (let i = pool.length - 1; i >= 0; i--) if (w.getCard(pool[i])!.deletedAt) pool.splice(i, 1)
      } else if (r < 0.78) {
        const n = 1 + Math.floor(rng() * 3)
        const victims: string[] = []
        for (let i = 0; i < n && pool.length > 0; i++) {
          const idx = Math.floor(rng() * pool.length)
          victims.push(pool.splice(idx, 1)[0])
        }
        if (victims.length > 0) w.deleteCards(victims)
      } else if (r < 0.88) {
        if (pool.length > 0) {
          const id = pool[Math.floor(rng() * pool.length)]
          const card = w.getCard(id)!
          if (!card.deletedAt) w.setCardSuspended(id, !card.suspended)
        }
      } else if (r < 0.94) {
        if (pool.length > 0) {
          const id = pool[Math.floor(rng() * pool.length)]
          if (!w.getCard(id)!.deletedAt) w.resetProgress([id])
        }
      } else {
        if (pool.length > 0) {
          const id = pool[Math.floor(rng() * pool.length)]
          if (!w.getCard(id)!.deletedAt) w.moveCards([id], decks[Math.floor(rng() * decks.length)])
        }
      }
      assertIndexMatchesScan(w)
    }

    // 重启重放后索引从零构建，同样必须与全量扫描一致
    const dir = w.root
    const w2 = newWs(dir)
    assertIndexMatchesScan(w2)
  })

  it('同毫秒批量加卡：取卡顺序与添加顺序一致（tie 决胜）', () => {
    const w = newWs(tmp())
    const d = w.addDeck('tie 组').id
    const added = w.addCards(d, [
      { front: 'tie 一', back: '' },
      { front: 'tie 二', back: '' },
      { front: 'tie 三', back: '' }
    ])
    expect(added[0].createdAt).toBe(added[2].createdAt)
    const order: string[] = []
    for (let i = 0; i < 3; i++) {
      const study = w.getStudy(d)
      expect(study.card).not.toBeNull()
      order.push(study.card!.id)
      w.answer(study.card!.id, 3)
    }
    expect(order).toEqual(added.map((c) => c.id))
  })

  it('撤销回到新卡后仍保持原顺序位（tie 不随重入堆改变）', () => {
    const w = newWs(tmp())
    const d = w.addDeck('tie 撤销').id
    const [a, b] = w.addCards(d, [
      { front: 'tieA', back: '' },
      { front: 'tieB', back: '' }
    ])
    w.answer(a.id, 3)
    w.undo()
    // a 回到新卡，createdAt 与 b 相同，但 a 原本在 b 之前 → 仍先出 a
    expect(w.getStudy(d).card?.id).toBe(a.id)
    expect(w.getStudy(d).card?.id).not.toBe(b.id)
  })

  it('跨天：到期日进入新一天的复习卡计入 remaining 并出卡（假时钟模拟）', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-06T10:00:00'))
      const w = newWs(tmp())
      const d = w.addDeck('跨天组').id
      const c = w.addCard(d, '跨天卡', '')
      w.answer(c.id, 4) // Easy 毕业 → due 在未来数天
      expect(w.getStudy(d).remaining).toBe(0) // due 超出今日末
      vi.setSystemTime(new Date('2026-10-06T10:00:00')) // +30 天
      expect(w.getStudy(d).remaining).toBe(1) // due 落入新"今日末"窗口
      expect(w.getStudy(d).card?.id).toBe(c.id) // 已到期 → 出卡
    } finally {
      vi.useRealTimers()
    }
  })

  it('堆死条目过半重建：状态反复变更后取卡/到期计数仍与全量扫描一致（rebuildHeapsIfStale）', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-06T10:00:00'))
      const w = newWs(tmp())
      const d = w.addDeck('重建组').id
      // >32 张（小堆早退线），反复答题/暂停/解除/软删制造死条目，逼过半阈值触发全量重灌
      const cards = w.addCards(
        d,
        Array.from({ length: 40 }, (_, i) => ({ front: `重建${i}`, back: '' }))
      )
      // 建堆
      expect(w.getStudy(d).card).not.toBeNull()
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < 20; i++) {
          const c = cards[i]
          w.answer(c.id, 3) // 入 learning（10 分钟步长，死条目 +1）
          w.setCardSuspended(c.id, true) // 暂停（旧条目再死 +1）
          w.setCardSuspended(c.id, false) // 解除（classPush 新条目）
        }
        // 每轮都过一遍对拍：重建后堆内容、计数、dueNow 都必须与全量扫描一致
        const now = Date.now()
        const list = refCards(w, d)
        const info = w.deckInfos().find((x) => x.id === d)!
        expect(info.counts).toEqual(refTableCounts(list, now))
        const s = w.getStudy(d)
        expect(s.card?.id ?? null).toBe(pickNext(list, now, w.endOfToday())?.id ?? null)
      }
      // 40 张里 20 张状态反复变更 ≥3 轮：stale 远超堆半，重灌必然发生——对拍通过即分支生效
    } finally {
      vi.useRealTimers()
    }
  })

  it('隐藏牌组（软删）不触发堆重建，索引口径保持 dueNowOf 不变', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-06T10:00:00'))
      const w = newWs(tmp())
      const d = w.addDeck('隐藏重建组').id
      const cards = w.addCards(
        d,
        Array.from({ length: 40 }, (_, i) => ({ front: `隐藏${i}`, back: '' }))
      )
      expect(w.getStudy(d).card).not.toBeNull() // 建堆
      for (let i = 0; i < 20; i++) {
        w.answer(cards[i].id, 3)
        w.setCardSuspended(cards[i].id, true)
      }
      // 软删牌组：其卡从计数消失；再对牌组内做变更也不再入堆/重建（早退分支）
      w.deleteDeck(d)
      const list = refCards(w, d) // refCards 同样排除软删牌组 → 空
      const info = w.deckInfos().find((x) => x.id === d)
      // 软删后 deckInfos 不再展示该牌组；这里只验证服务层不炸、其他牌组计数不受影响
      expect(info).toBeUndefined()
      expect(list).toHaveLength(0)
      // 全库对拍仍一致（隐藏牌组早退不影响其余索引）
      for (const deck of w.decks.filter((x) => !x.deletedAt)) {
        const l = refCards(w, deck.id)
        const inf = w.deckInfos().find((x) => x.id === deck.id)!
        expect(inf.counts).toEqual(refTableCounts(l, Date.now()))
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('getStudy 幂等：连续调用返回同一张卡，未被消费', () => {    // 固定上午时刻：+10min 学习步长不会跨午夜（真时钟在 23:50 后跑会因 due 落入明日而差 1）
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-06T10:00:00'))
      const w = newWs(tmp())
      const d = w.addDeck('幂等组').id
      const [a, b] = w.addCards(d, [
        { front: '幂等A', back: '' },
        { front: '幂等B', back: '' }
      ])
      expect(w.getStudy(d).card?.id).toBe(a.id)
      expect(w.getStudy(d).card?.id).toBe(a.id)
      w.answer(a.id, 3) // a 进入 learning（10 分钟内到期，due<=今日末）
      const s = w.getStudy(d)
      expect(s.card?.id).toBe(b.id) // learning 未到期不出，新卡 b 顶上
      expect(w.getStudy(d).card?.id).toBe(b.id)
      expect(w.getStudy(d).remaining).toBe(2) // b（新）+ a（learning 今日内）
    } finally {
      vi.useRealTimers()
    }
  })
})
