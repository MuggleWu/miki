// replay / queue / query / stats 回归
import { describe, expect, it } from 'vitest'
import { replayCard } from '../replay'
import { deckCounts, pickNext, remainingCount } from '../queue'
import { compareByKeys, filterByKeywords, rotateSort, toRow } from '../query'
import { bumpDailyAgg, computeStats, type DailyAgg } from '../stats'
import { FsrScheduler, DEFAULT_FSRS_PARAMS } from '../fsrs'
import type { Card, CardContent, ReviewEvent, SortKey } from '../../shared/types'
import { FSRS_STATE } from '../../shared/types'

const DAY = 86_400_000
const T0 = new Date('2026-09-01T08:00:00').getTime()

const noFuzz = { ...DEFAULT_FSRS_PARAMS, enableFuzzing: false }
const sched = new FsrScheduler(noFuzz)

function content(id: string, deckId = 'd1', createdAt = T0): CardContent {
  return { id, front: `${id} front`, back: `${id} back`, createdAt, updatedAt: createdAt, deletedAt: null, suspended: false }
}

function cardOf(id: string, deckId = 'd1', createdAt = T0): Card {
  return { ...content(id, deckId, createdAt), deckId, fsrs: null, reps: 0, lapses: 0, suspended: false }
}

function answerEv(seq: number, card: Card, rating: 1 | 2 | 3 | 4, t: number): ReviewEvent {
  const before = card.fsrs
  const after = sched.review(before, rating, t)
  return { seq, t, action: 'answer', cardId: card.id, deckId: card.deckId, rating, before, after }
}

/** 事件流 → 热力图聚合（含 undo 抵消），computeStats 适配器 */
function aggOf(evs: ReviewEvent[]): DailyAgg {
  const agg: DailyAgg = new Map()
  const answers = new Map<number, ReviewEvent>()
  for (const e of evs) {
    if (e.action === 'answer') {
      bumpDailyAgg(agg, e.deckId, e.t, e.rating, 1)
      answers.set(e.seq, e)
    } else if (e.action === 'undo' && e.targetSeq != null) {
      const t = answers.get(e.targetSeq)
      if (t) bumpDailyAgg(agg, t.deckId, t.t, t.rating, -1)
    }
  }
  return agg
}

describe('replay', () => {
  it('answer 事件链重放出调度状态与 reps/lapses', () => {
    let c = cardOf('c1')
    const evs: ReviewEvent[] = []
    // 新卡 Good → 进入第 2 个 learning step（10min）
    evs.push(answerEv(1, c, 3, T0))
    c = replayCard(content('c1'), 'd1', evs)
    expect(c.fsrs).not.toBeNull()
    expect(c.reps).toBe(1)
    expect(c.fsrs!.state).toBe(FSRS_STATE.Learning)
    expect(c.fsrs!.step).toBe(1)
    // 10min 后 Good → 毕业 Review
    evs.push(answerEv(2, c, 3, T0 + 600_000))
    c = replayCard(content('c1'), 'd1', evs)
    expect(c.fsrs!.state).toBe(FSRS_STATE.Review)
    expect(c.fsrs!.step).toBeNull()
    expect(c.reps).toBe(2)
  })

  it('Again 计 lapse；undo 抵消 answer', () => {
    let c = cardOf('c2')
    const evs: ReviewEvent[] = []
    evs.push(answerEv(1, c, 3, T0))
    c = replayCard(content('c2'), 'd1', evs)
    evs.push(answerEv(2, c, 3, T0 + 60_000))
    c = replayCard(content('c2'), 'd1', evs)
    evs.push(answerEv(3, c, 1, T0 + 60_000 + 600_000 + 3 * DAY))
    c = replayCard(content('c2'), 'd1', evs)
    expect(c.lapses).toBe(1)
    expect(c.reps).toBe(3)
    // 撤销第 3 次 answer
    const undoEv: ReviewEvent = {
      seq: 4,
      t: T0 + 60_000 + 600_000 + 3 * DAY + 5_000,
      action: 'undo',
      cardId: c.id,
      deckId: c.deckId,
      targetSeq: 3,
      before: evs[2].before!
    }
    evs.push(undoEv)
    c = replayCard(content('c2'), 'd1', evs)
    expect(c.reps).toBe(2)
    expect(c.lapses).toBe(0)
    // 调度状态回到第 3 次答题前
    expect(c.fsrs).toEqual(evs[2].before)
  })

  it('reset 清零调度与统计，其后再答题正常累积', () => {
    let c = cardOf('c4')
    const evs: ReviewEvent[] = [answerEv(1, c, 1, T0), answerEv(2, c, 3, T0 + 60_000)]
    c = replayCard(content('c4'), 'd1', evs)
    expect(c.reps).toBe(2)
    expect(c.fsrs).not.toBeNull()
    // 重置：变回新卡
    const resetEv: ReviewEvent = { seq: 3, t: T0 + 120_000, action: 'reset', cardId: c.id, deckId: c.deckId, before: c.fsrs }
    evs.push(resetEv)
    c = replayCard(content('c4'), 'd1', evs)
    expect(c.fsrs).toBeNull()
    expect(c.reps).toBe(0)
    expect(c.lapses).toBe(0)
    // 重置后再答题照常推进
    evs.push(answerEv(4, c, 3, T0 + 180_000))
    c = replayCard(content('c4'), 'd1', evs)
    expect(c.reps).toBe(1)
    expect(c.fsrs).not.toBeNull()
  })

  it('delete 软删后 undo 恢复', () => {
    let c = cardOf('c3')
    const evs = [answerEv(1, c, 4, T0)]
    const delEv: ReviewEvent = { seq: 2, t: T0 + 1000, action: 'delete', cardId: c.id, deckId: c.deckId, before: evs[0].after! }
    evs.push(delEv)
    c = replayCard(content('c3'), 'd1', evs)
    expect(c.deletedAt).toBe(T0 + 1000)
    evs.push({ seq: 3, t: T0 + 2000, action: 'undo', cardId: c.id, deckId: c.deckId, targetSeq: 2, before: evs[0].after! })
    c = replayCard(content('c3'), 'd1', evs)
    expect(c.deletedAt).toBeNull()
    expect(c.fsrs).toEqual(evs[0].after)
  })
})

describe('queue（D3 不限额）', () => {
  const eotOf = (now: number): number => {
    const d = new Date(now)
    d.setHours(23, 59, 59, 999)
    return d.getTime()
  }

  it('learning 到点 → review 当日到期 → new 的优先序', () => {
    const now = T0 + 10 * DAY
    const eot = eotOf(now)
    const learnDue = cardOf('l1')
    learnDue.fsrs = sched.review(null, 1, T0) // Again → 1min 后
    const reviewDue = cardOf('r1')
    reviewDue.fsrs = sched.review(sched.review(sched.review(null, 3, T0), 3, T0 + 660_000), 3, T0 + 660_000 + 600_000)
    reviewDue.fsrs.due = now - 1000 // 已过期
    const fresh = cardOf('n1')
    const cards = [fresh, reviewDue, learnDue]
    expect(pickNext(cards, now, eot)!.id).toBe('l1')
    const cards2 = [fresh, reviewDue]
    expect(pickNext(cards2, now, eot)!.id).toBe('r1')
    expect(pickNext([fresh], now, eot)!.id).toBe('n1')
    expect(pickNext([], now, eot)).toBeNull()
  })

  it('刷完旧卡才能刷新卡：当日稍后到点的复习卡先于新卡', () => {
    const now = T0 + 10 * DAY // 上午
    const eot = eotOf(now)
    const laterToday = cardOf('r2')
    laterToday.fsrs = {
      state: FSRS_STATE.Review, step: null, stability: 5, difficulty: 5,
      due: eot - 3_600_000, lastReview: now - DAY // 今日 22 点到期，此刻未到点
    }
    const fresh = cardOf('n1')
    expect(pickNext([fresh, laterToday], now, eot)!.id).toBe('r2')
  })

  it('明日及以后到期的复习卡不阻塞新卡', () => {
    const now = T0 + 10 * DAY
    const eot = eotOf(now)
    const tomorrow = cardOf('r3')
    tomorrow.fsrs = {
      state: FSRS_STATE.Review, step: null, stability: 5, difficulty: 5,
      due: eot + 60_000, lastReview: now - DAY // 明日到期
    }
    const fresh = cardOf('n1')
    expect(pickNext([fresh, tomorrow], now, eot)!.id).toBe('n1')
  })

  it('学习中回炉卡未到点不阻塞新卡，到点后插回优先位', () => {
    const now = T0 + 10 * DAY
    const eot = eotOf(now)
    const comeback = cardOf('l2')
    comeback.fsrs = sched.review(null, 3, T0) // Good → 10min 步进
    comeback.fsrs.due = now + 5 * 60_000 // 5 分钟后到期
    const fresh = cardOf('n1')
    expect(pickNext([fresh, comeback], now, eot)!.id).toBe('n1')
    comeback.fsrs.due = now // 到点了
    expect(pickNext([fresh, comeback], now, eot)!.id).toBe('l2')
  })

  it('同 rank 按 due 升序', () => {
    const now = T0 + 10 * DAY
    const eot = eotOf(now)
    const a = cardOf('a')
    const b = cardOf('b')
    a.fsrs = { state: FSRS_STATE.Review, step: null, stability: 5, difficulty: 5, due: now - 2000, lastReview: T0 }
    b.fsrs = { state: FSRS_STATE.Review, step: null, stability: 5, difficulty: 5, due: now - 1000, lastReview: T0 }
    expect(pickNext([b, a], now, eot)!.id).toBe('a')
  })

  it('remaining 与 deckCounts 口径', () => {
    const now = T0
    const endOfToday = new Date(now); endOfToday.setHours(23, 59, 59, 999)
    const newCard = cardOf('n')
    const learn = cardOf('l')
    learn.fsrs = sched.review(null, 1, T0) // 1min 后再刷
    const review = cardOf('r')
    review.fsrs = { state: FSRS_STATE.Review, step: null, stability: 5, difficulty: 5, due: endOfToday.getTime(), lastReview: T0 - DAY }
    const future = cardOf('f')
    future.fsrs = { state: FSRS_STATE.Review, step: null, stability: 30, difficulty: 5, due: now + 20 * DAY, lastReview: T0 - 10 * DAY }
    const cards = [newCard, learn, review, future]
    expect(remainingCount(cards, endOfToday.getTime())).toBe(3)
    const counts = deckCounts(cards, endOfToday.getTime())
    expect(counts).toEqual({ new: 1, learning: 1, review: 1 })
  })
  it('suspended 卡不进队列与计数', () => {
    const now = T0 + 120_000 // 学习卡 1min 后到期，此刻必然可刷
    const endOfToday = new Date(T0); endOfToday.setHours(23, 59, 59, 999)
    const pausedNew = { ...cardOf('p1'), suspended: true }
    const pausedDue = { ...cardOf('p2'), suspended: true }
    pausedDue.fsrs = { state: FSRS_STATE.Review, step: null, stability: 5, difficulty: 5, due: endOfToday.getTime(), lastReview: T0 - DAY }
    const normal = cardOf('p3')
    normal.fsrs = sched.review(null, 1, T0) // 1min 后到期
    const cards = [pausedNew, pausedDue, normal]
    expect(pickNext(cards, now, endOfToday.getTime())!.id).toBe('p3')
    expect(remainingCount(cards, endOfToday.getTime())).toBe(1)
    expect(deckCounts(cards, endOfToday.getTime())).toEqual({ new: 0, learning: 1, review: 0 })
  })
})

describe('query', () => {
  const mk = (id: string, front: string, back: string, updatedAt: number): Card => ({
    ...content(id), deckId: 'd1', front, back, updatedAt, fsrs: null, reps: 0, lapses: 0
  })
  const cards = [
    mk('c1', '税法 增值税', 'back1', T0 + 3),
    mk('c2', '行测 数量关系', '增值税 front', T0 + 1),
    mk('c3', '英语 单词', 'back3', T0 + 2)
  ]

  it('多关键词 AND、大小写不敏感，正反面都搜', () => {
    expect(filterByKeywords(cards, ['增值税']).map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(filterByKeywords(cards, ['增值', '行测']).map((c) => c.id)).toEqual(['c2'])
    expect(filterByKeywords(cards, ['ABC']).length).toBe(0)
  })

  it('B4 rotate：点击列提为首位，再点翻转', () => {
    let keys: SortKey[] = [{ col: 'updatedAt', asc: false }]
    keys = rotateSort(keys, 'front')
    // front 提为首位，其余保序
    expect(keys).toEqual([
      { col: 'front', asc: true },
      { col: 'updatedAt', asc: false }
    ])
    keys = rotateSort(keys, 'updatedAt')
    // updatedAt 提为首位（默认升序）
    expect(keys).toEqual([
      { col: 'updatedAt', asc: true },
      { col: 'front', asc: true }
    ])
    keys = rotateSort(keys, 'updatedAt')
    // 已是首位 → 翻转为降序
    expect(keys).toEqual([
      { col: 'updatedAt', asc: false },
      { col: 'front', asc: true }
    ])
  })

  it('多列排序：主键相同看次键', () => {
    const deckOf = () => 'd'
    const a = { ...mk('a', 'x', 'b', T0), reps: 1 }
    const b = { ...mk('b', 'x', 'a', T0), reps: 2 }
    const keys: SortKey[] = [{ col: 'front', asc: true }, { col: 'reps', asc: false }]
    const sorted = [a, b].sort((x, y) => compareByKeys(x, y, keys, deckOf))
    // front 相同 → reps 降序 → b(reps=2) 在前
    expect(sorted.map((c) => c.id)).toEqual(['b', 'a'])
    const keys2: SortKey[] = [{ col: 'reps', asc: false }]
    expect(compareByKeys(b, a, keys2, deckOf)).toBeLessThan(0)
  })

  it('toRow 展示状态', () => {
    const c = cardOf('c9')
    c.fsrs = { state: FSRS_STATE.Review, step: null, stability: 3.5, difficulty: 6, due: T0 + 5 * DAY, lastReview: T0 }
    const row = toRow(c, '牌组A')
    expect(row.state).toBe('review')
    expect(row.intervalDays).toBe(5)
    expect(row.deckName).toBe('牌组A')
    expect(row.suspended).toBe(false)
    const newCard = toRow(cardOf('c10'), 'd')
    expect(newCard.state).toBe('new')
    expect(newCard.intervalDays).toBeNull()
    const paused = toRow({ ...cardOf('c11'), suspended: true }, 'd')
    expect(paused.suspended).toBe(true)
  })
})

describe('stats', () => {
  it('五板块基本口径', () => {
    const now = T0 + 10 * DAY
    const endOfToday = new Date(now); endOfToday.setHours(23, 59, 59, 999)
    const c1 = cardOf('s1')
    const c2 = cardOf('s2', 'd2')
    const evs: ReviewEvent[] = []
    let tmp = c1
    for (let i = 0; i < 3; i++) {
      const ev = answerEv(i + 1, tmp, 3, T0 + i * DAY)
      evs.push(ev)
      tmp = { ...tmp, fsrs: ev.after ?? null }
    }
    // 抵消最后一个
    evs.push({ seq: 4, t: T0 + 3 * DAY, action: 'undo', cardId: c1.id, deckId: c1.deckId, targetSeq: 3, before: evs[2].before! })
    const cards = [tmp, c2]
    const agg = aggOf(evs)
    const s = computeStats({ cards, dailyAgg: agg, deckId: null, range: 'year', now })
    expect(s.reviews.reduce((acc, r) => acc + r.total, 0)).toBe(2) // undo 抵消后
    expect(s.stateCounts.new).toBe(1) // c2 是 d2 的 new 卡
    expect(s.heatmap.length).toBe(365)
    expect(s.forecast.length).toBe(38) // 等宽自适应分桶，柱数不变
    const s2 = computeStats({ cards, dailyAgg: agg, deckId: 'd1', range: 'year', now })
    expect(s2.stateCounts.new).toBe(0)
  })

  it('预测等宽分桶：year 档未来 365 天均分 38 桶，超视野/暂停/今天内到期不计', () => {
    const now = T0 + 10 * DAY
    const mk = (id: string, dueOffsetDay: number, suspended = false): Card => {
      const c = cardOf(id)
      c.suspended = suspended
      c.fsrs = { state: FSRS_STATE.Review, step: null, stability: 5, difficulty: 5, due: T0 + 10 * DAY + dueOffsetDay * DAY, lastReview: T0 }
      return c
    }
    const cards = [mk('f1', 100), mk('f2', 400), mk('f3', 50, true), mk('f4', 0)] // f2 超一年 f3 暂停 f4 今天内
    const s = computeStats({ cards, dailyAgg: new Map(), deckId: null, range: 'year', now })
    expect(s.forecast.length).toBe(38)
    expect(s.forecast.reduce((a, f) => a + f.count, 0)).toBe(1)
    // f1 距窗口左界约 99.33 天，桶宽 365/38 ≈ 9.605 天 → 第 10 桶
    expect(s.forecast[10].count).toBe(1)
    expect(s.forecast[0].range).toMatch(/^09-11 ~ /) // 桶宽 <25 天时 range 不带年份
  })

  it('预测等宽分桶：all 档最远到期减最早逾期均分，逾期进首柱、最远进末柱', () => {
    const now = T0 + 10 * DAY
    const mk = (id: string, dueDay: number): Card => {
      const c = cardOf(id)
      c.fsrs = { state: FSRS_STATE.Review, step: null, stability: 5, difficulty: 5, due: T0 + dueDay * DAY, lastReview: T0 }
      return c
    }
    const cards = [mk('g1', 2), mk('g2', 40), mk('g3', 100)] // 跨度 98 天，桶宽 98/38 ≈ 2.579 天
    const s = computeStats({ cards, dailyAgg: new Map(), deckId: null, range: 'all', now })
    expect(s.forecast.length).toBe(38)
    expect(s.forecast[0].count).toBe(1) // 最早逾期（g1）
    // g2 offset 38 天 → floor(38/2.5789) = 14
    expect(s.forecast[14].count).toBe(1)
    expect(s.forecast[37].count).toBe(1) // 最远到期 clamp 末柱
    expect(s.forecast.reduce((a, f) => a + f.count, 0)).toBe(3)
    // 同一批卡在 year 档：逾期 g1 不计；g2(10-21)、g3(12-19) 落入未来窗口
    const sy = computeStats({ cards, dailyAgg: new Map(), deckId: null, range: 'year', now })
    expect(sy.forecast.reduce((a, f) => a + f.count, 0)).toBe(2)
  })

  it('预测等宽分桶：无已调度卡时回退零柱', () => {
    const s = computeStats({ cards: [cardOf('h1')], dailyAgg: new Map(), deckId: null, range: 'all', now: T0 })
    expect(s.forecast.length).toBe(38)
    expect(s.forecast.every((f) => f.count === 0)).toBe(true)
  })

  it('间隔分段', () => {
    const now = T0 + 5 * DAY
    const c = cardOf('i1')
    c.fsrs = { state: FSRS_STATE.Review, step: null, stability: 10, difficulty: 5, due: T0 + 5 * DAY + 6 * DAY, lastReview: T0 + 5 * DAY }
    const s = computeStats({ cards: [c], dailyAgg: new Map(), deckId: null, range: 'all', now })
    expect(s.intervals.find((b) => b.bucket === '4-7')!.count).toBe(1)
  })
})
