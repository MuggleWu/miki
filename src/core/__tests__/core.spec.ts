// replay / queue / query / stats 回归
import { describe, expect, it, vi } from 'vitest'
import { replayCard } from '../replay'
import { deckCounts, pickNext, remainingCount } from '../queue'
import { compareByKeys, filterCards, rotateSort, sortByKeys, toRow } from '../query'
import { bumpDailyAgg, computeStats, normalizeBucket, statsCacheKey, type DailyAgg, type StatsInput } from '../stats'
import { FsrScheduler, DEFAULT_FSRS_PARAMS } from '../fsrs'
import type { Card, CardContent, QueryParams, Rating, ReviewEvent, SortKey } from '../../shared/types'
import { FSRS_STATE } from '../../shared/types'

const DAY = 86_400_000
const T0 = new Date('2026-09-01T08:00:00').getTime()

const noFuzz = { ...DEFAULT_FSRS_PARAMS, enableFuzzing: false }
const sched = new FsrScheduler(noFuzz)

function content(id: string, _deckId = 'd1', createdAt = T0): CardContent {
  return {
    id,
    front: `${id} front`,
    back: `${id} back`,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    suspended: false
  }
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
      // durationMs 与 workspace 重放路径一致地传下去（留存率摘要要用它算均耗时）
      bumpDailyAgg(agg, e.deckId, e.t, e.rating, 1, e.durationMs)
      answers.set(e.seq, e)
    } else if (e.action === 'undo' && e.targetSeq != null) {
      const t = answers.get(e.targetSeq)
      if (t) bumpDailyAgg(agg, t.deckId, t.t, t.rating, -1, t.durationMs)
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
    const resetEv: ReviewEvent = {
      seq: 3,
      t: T0 + 120_000,
      action: 'reset',
      cardId: c.id,
      deckId: c.deckId,
      before: c.fsrs
    }
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
    const delEv: ReviewEvent = {
      seq: 2,
      t: T0 + 1000,
      action: 'delete',
      cardId: c.id,
      deckId: c.deckId,
      before: evs[0].after!
    }
    evs.push(delEv)
    c = replayCard(content('c3'), 'd1', evs)
    expect(c.deletedAt).toBe(T0 + 1000)
    evs.push({
      seq: 3,
      t: T0 + 2000,
      action: 'undo',
      cardId: c.id,
      deckId: c.deckId,
      targetSeq: 2,
      before: evs[0].after!
    })
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
      state: FSRS_STATE.Review,
      step: null,
      stability: 5,
      difficulty: 5,
      due: eot - 3_600_000,
      lastReview: now - DAY // 今日 22 点到期，此刻未到点
    }
    const fresh = cardOf('n1')
    expect(pickNext([fresh, laterToday], now, eot)!.id).toBe('r2')
  })

  it('明日及以后到期的复习卡不阻塞新卡', () => {
    const now = T0 + 10 * DAY
    const eot = eotOf(now)
    const tomorrow = cardOf('r3')
    tomorrow.fsrs = {
      state: FSRS_STATE.Review,
      step: null,
      stability: 5,
      difficulty: 5,
      due: eot + 60_000,
      lastReview: now - DAY // 明日到期
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
    const endOfToday = new Date(now)
    endOfToday.setHours(23, 59, 59, 999)
    const newCard = cardOf('n')
    const learn = cardOf('l')
    learn.fsrs = sched.review(null, 1, T0) // 1min 后再刷
    const review = cardOf('r')
    review.fsrs = {
      state: FSRS_STATE.Review,
      step: null,
      stability: 5,
      difficulty: 5,
      due: endOfToday.getTime(),
      lastReview: T0 - DAY
    }
    const future = cardOf('f')
    future.fsrs = {
      state: FSRS_STATE.Review,
      step: null,
      stability: 30,
      difficulty: 5,
      due: now + 20 * DAY,
      lastReview: T0 - 10 * DAY
    }
    const cards = [newCard, learn, review, future]
    expect(remainingCount(cards, endOfToday.getTime())).toBe(3)
    const counts = deckCounts(cards, endOfToday.getTime())
    expect(counts).toEqual({ new: 1, learning: 1, review: 1 })
  })
  it('suspended 卡不进队列与计数', () => {
    const now = T0 + 120_000 // 学习卡 1min 后到期，此刻必然可刷
    const endOfToday = new Date(T0)
    endOfToday.setHours(23, 59, 59, 999)
    const pausedNew = { ...cardOf('p1'), suspended: true }
    const pausedDue = { ...cardOf('p2'), suspended: true }
    pausedDue.fsrs = {
      state: FSRS_STATE.Review,
      step: null,
      stability: 5,
      difficulty: 5,
      due: endOfToday.getTime(),
      lastReview: T0 - DAY
    }
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
    ...content(id),
    deckId: 'd1',
    front,
    back,
    updatedAt,
    fsrs: null,
    reps: 0,
    lapses: 0
  })
  const cards = [
    mk('c1', '税法 增值税', 'back1', T0 + 3),
    mk('c2', '行测 数量关系', '增值税 front', T0 + 1),
    mk('c3', '英语 单词', 'back3', T0 + 2)
  ]

  it('多关键词 AND、大小写不敏感，正反面都搜', () => {
    // filterCards 关键词路径：小写化在函数内做，lowerOf 只需原样返回文本
    const ids = (params: Partial<QueryParams>) =>
      filterCards(cards, { deckId: null, keywords: [], sort: [], ...params }, (c) => [
        c.front.toLowerCase(),
        c.back.toLowerCase()
      ]).map((c) => c.id)
    expect(ids({ keywords: ['增值税'] })).toEqual(['c1', 'c2'])
    expect(ids({ keywords: ['增值', '行测'] })).toEqual(['c2'])
    expect(ids({ keywords: ['ABC'] })).toEqual([])
    expect(ids({ keywords: ['增值税', 'FRONT'] })).toEqual(['c2']) // 一词中正面、另一词反面，仍 AND 命中
  })

  it('B3 单趟过滤：无条件快路径 / 状态合并 / due 窗口排除无调度卡 / suspended 语义', () => {
    const lowerOf = (c: Card) => [c.front.toLowerCase(), c.back.toLowerCase()] as [string, string]
    const q = (params: Partial<QueryParams>) =>
      filterCards(cards, { deckId: null, keywords: [], sort: [], ...params }, lowerOf)

    // 无条件：返回原数组引用（快路径）
    expect(q({})).toBe(cards)

    // 状态：new（无 fsrs）、suspended、learning 的合并判定
    const learn = {
      ...mk('cl', '学习卡', '', T0),
      fsrs: {
        state: FSRS_STATE.Learning,
        step: 0,
        stability: 1,
        difficulty: 5,
        due: T0 + 600_000,
        lastReview: T0
      } as Card['fsrs']
    }
    const withStates = [...cards, learn, { ...mk('cs', '暂停卡', '', T0), suspended: true }]
    const qAll = (params: Partial<QueryParams>) =>
      filterCards(withStates, { deckId: null, keywords: [], sort: [], ...params }, lowerOf)
    expect(qAll({ state: 'new' }).map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
    expect(qAll({ state: 'learning' }).map((c) => c.id)).toEqual(['cl'])
    expect(qAll({ state: 'suspended' }).map((c) => c.id)).toEqual(['cs'])
    // 非 suspended 状态排除暂停卡
    expect(qAll({ state: 'review' }).map((c) => c.id)).toEqual([])

    // due 窗口：无调度卡一律排除；有调度卡按 due 落窗判定
    expect(qAll({ dueAfter: T0 + 1, dueBefore: T0 + 2 }).map((c) => c.id)).toEqual([])
    const learnDue = {
      ...mk('cd', '到期学习卡', '', T0),
      fsrs: {
        state: FSRS_STATE.Learning,
        step: 0,
        stability: 1,
        difficulty: 5,
        due: T0 + 600_000,
        lastReview: T0
      } as Card['fsrs']
    }
    expect(
      filterCards(
        [learnDue],
        { deckId: null, keywords: [], sort: [], dueAfter: T0, dueBefore: T0 + 86_400_000 },
        lowerOf
      ).map((c) => c.id)
    ).toEqual(['cd'])
    expect(
      filterCards([learnDue], { deckId: null, keywords: [], sort: [], dueAfter: T0 + 86_400_000 }, lowerOf)
    ).toEqual([])

    // 组合：状态 + 关键词单趟同时生效
    expect(qAll({ state: 'new', keywords: ['税法'] }).map((c) => c.id)).toEqual(['c1'])
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
    const keys: SortKey[] = [
      { col: 'front', asc: true },
      { col: 'reps', asc: false }
    ]
    const sorted = [a, b].sort((x, y) => compareByKeys(x, y, keys, deckOf))
    // front 相同 → reps 降序 → b(reps=2) 在前
    expect(sorted.map((c) => c.id)).toEqual(['b', 'a'])
    const keys2: SortKey[] = [{ col: 'reps', asc: false }]
    expect(compareByKeys(b, a, keys2, deckOf)).toBeLessThan(0)
  })

  it('sortByKeys 装饰排序与 compareByKeys 直接比较逐元素对拍；null 值/降序/中文序/id 决胜', () => {
    const deckOf = () => '牌组甲'
    // null（无 fsrs → due/interval/stability 为 null）、同键值（逼 id 决胜）、中文、降序混合
    const mkDue = (id: string, due: number | null, front: string): Card => {
      const base = mk(id, front, '', T0 + 3)
      return due == null
        ? base
        : {
            ...base,
            fsrs: {
              state: FSRS_STATE.Review,
              step: null,
              stability: 3,
              difficulty: 5,
              due,
              lastReview: T0
            } as Card['fsrs']
          }
    }
    const list = [
      mkDue('n1', null, '中文甲'),
      mkDue('r1', T0 + 5, '中文乙'),
      mkDue('r2', T0 + 5, '中文丙'), // due 同 → id 决胜
      mkDue('r3', T0 + 2, 'apple'),
      mkDue('r4', T0 + 9, 'Banana')
    ]
    const keySets: SortKey[][] = [
      [{ col: 'due', asc: true }],
      [{ col: 'due', asc: false }],
      [{ col: 'front', asc: true }],
      [{ col: 'front', asc: false }],
      [
        { col: 'due', asc: true },
        { col: 'front', asc: false }
      ],
      [] // 空键：跳过排序返回原引用
    ]
    for (const keys of keySets) {
      const decorated = sortByKeys([...list], keys, deckOf)
      const direct = [...list].sort((x, y) => compareByKeys(x, y, keys, deckOf))
      expect(decorated.map((c) => c.id)).toEqual(direct.map((c) => c.id))
    }
    // null 恒排最前（升降序皆然），同 due 按 id 决胜，中文按拼音（乙 yǐ < 丙 bǐng？—— localeCompare 定序，只锁确定性）
    expect(sortByKeys([...list], [{ col: 'due', asc: true }], deckOf).map((c) => c.id)).toEqual([
      'n1',
      'r3',
      'r1',
      'r2',
      'r4'
    ])
    expect(sortByKeys([...list], [{ col: 'due', asc: false }], deckOf).map((c) => c.id)).toEqual([
      'r4',
      'r1',
      'r2',
      'r3',
      'n1'
    ])
    // 空键返回原数组引用
    const original = [list[1], list[0]]
    expect(sortByKeys(original, [], deckOf)).toBe(original)
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
    const endOfToday = new Date(now)
    endOfToday.setHours(23, 59, 59, 999)
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
    evs.push({
      seq: 4,
      t: T0 + 3 * DAY,
      action: 'undo',
      cardId: c1.id,
      deckId: c1.deckId,
      targetSeq: 3,
      before: evs[2].before!
    })
    const cards = [tmp, c2]
    const agg = aggOf(evs)
    const s = computeStats({
      desiredRetention: 0.9,
      cards,
      dailyAgg: agg,
      deckId: null,
      hiddenDeckIds: [],
      range: 'year',
      now
    })
    expect(s.reviews.reduce((acc, r) => acc + r.total, 0)).toBe(2) // undo 抵消后
    expect(s.stateCounts.new).toBe(1) // c2 是 d2 的 new 卡
    expect(s.heatmap.length).toBe(365)
    expect(s.forecast.length).toBe(38) // 等宽自适应分桶，柱数不变
    const s2 = computeStats({
      desiredRetention: 0.9,
      cards,
      dailyAgg: agg,
      deckId: 'd1',
      hiddenDeckIds: [],
      range: 'year',
      now
    })
    expect(s2.stateCounts.new).toBe(0)
  })

  it('预测等宽分桶：year 档未来 365 天均分 38 桶，超视野/暂停/今天内到期不计', () => {
    const now = T0 + 10 * DAY
    const mk = (id: string, dueOffsetDay: number, suspended = false): Card => {
      const c = cardOf(id)
      c.suspended = suspended
      c.fsrs = {
        state: FSRS_STATE.Review,
        step: null,
        stability: 5,
        difficulty: 5,
        due: T0 + 10 * DAY + dueOffsetDay * DAY,
        lastReview: T0
      }
      return c
    }
    const cards = [mk('f1', 100), mk('f2', 400), mk('f3', 50, true), mk('f4', 0)] // f2 超一年 f3 暂停 f4 今天内
    const s = computeStats({
      desiredRetention: 0.9,
      cards,
      dailyAgg: new Map(),
      deckId: null,
      hiddenDeckIds: [],
      range: 'year',
      now
    })
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
      c.fsrs = {
        state: FSRS_STATE.Review,
        step: null,
        stability: 5,
        difficulty: 5,
        due: T0 + dueDay * DAY,
        lastReview: T0
      }
      return c
    }
    const cards = [mk('g1', 2), mk('g2', 40), mk('g3', 100)] // 跨度 98 天，桶宽 98/38 ≈ 2.579 天
    const s = computeStats({
      desiredRetention: 0.9,
      cards,
      dailyAgg: new Map(),
      deckId: null,
      hiddenDeckIds: [],
      range: 'all',
      now
    })
    expect(s.forecast.length).toBe(38)
    expect(s.forecast[0].count).toBe(1) // 最早逾期（g1）
    // g2 offset 38 天 → floor(38/2.5789) = 14
    expect(s.forecast[14].count).toBe(1)
    expect(s.forecast[37].count).toBe(1) // 最远到期 clamp 末柱
    expect(s.forecast.reduce((a, f) => a + f.count, 0)).toBe(3)
    // 同一批卡在 year 档：逾期 g1 不计；g2(10-21)、g3(12-19) 落入未来窗口
    const sy = computeStats({
      desiredRetention: 0.9,
      cards,
      dailyAgg: new Map(),
      deckId: null,
      hiddenDeckIds: [],
      range: 'year',
      now
    })
    expect(sy.forecast.reduce((a, f) => a + f.count, 0)).toBe(2)
  })

  it('预测等宽分桶：无已调度卡时回退零柱', () => {
    const s = computeStats({
      desiredRetention: 0.9,
      cards: [cardOf('h1')],
      dailyAgg: new Map(),
      deckId: null,
      hiddenDeckIds: [],
      range: 'all',
      now: T0
    })
    expect(s.forecast.length).toBe(38)
    expect(s.forecast.every((f) => f.count === 0)).toBe(true)
  })

  it('间隔分段', () => {
    const now = T0 + 5 * DAY
    const c = cardOf('i1')
    c.fsrs = {
      state: FSRS_STATE.Review,
      step: null,
      stability: 10,
      difficulty: 5,
      due: T0 + 5 * DAY + 6 * DAY,
      lastReview: T0 + 5 * DAY
    }
    const s = computeStats({
      desiredRetention: 0.9,
      cards: [c],
      dailyAgg: new Map(),
      deckId: null,
      hiddenDeckIds: [],
      range: 'all',
      now
    })
    expect(s.intervals.find((b) => b.bucket === '4-7')!.count).toBe(1)
  })

  // 软删牌组：其下卡片必须与卡片库/首页同口径排除，否则统计页「卡片数量」与首页
  // 「总数」列对不上（实测真实数据差 3 张 = 3 个软删的冒烟临时牌组），用户无从解释。
  // 反向约束：只排除由卡片列表派生的统计；留存率/热力图/复习次数源自每日聚合，
  // 是「当天答过什么」的既成事实，不因删牌组而消失。
  it('软删牌组的卡片不进卡片类统计；其历史记录仍留在留存率与热力图里', () => {
    const live = cardOf('live-1', 'keep')
    const gone = cardOf('gone-1', 'deleted')
    const gone2 = cardOf('gone-2', 'deleted')
    const now = T0 + 10 * DAY
    // 两个牌组各有一次答题：删牌组后「卡片类」统计只剩 keep 的卡，但两次答题都还在
    const evs: ReviewEvent[] = [
      { seq: 1, t: T0, action: 'answer', cardId: 'live-1', deckId: 'keep', rating: 3 },
      { seq: 2, t: T0, action: 'answer', cardId: 'gone-1', deckId: 'deleted', rating: 3 }
    ]
    const agg = aggOf(evs)
    const all = [live, gone, gone2]

    const before = computeStats({
      desiredRetention: 0.9,
      cards: all,
      dailyAgg: agg,
      deckId: null,
      hiddenDeckIds: [],
      range: 'year',
      now
    })
    expect(before.stateCounts.new).toBe(3)
    expect(before.retention.total).toBe(2)

    const after = computeStats({
      desiredRetention: 0.9,
      cards: all,
      dailyAgg: agg,
      deckId: null,
      hiddenDeckIds: ['deleted'],
      range: 'year',
      now
    })
    // 卡片类统计：删牌组的 2 张卡消失
    expect(after.stateCounts.new).toBe(1)
    expect(after.stateCounts.new + after.stateCounts.learning + after.stateCounts.review).toBe(1)
    // 历史事实不消失：留存率分母、热力图、复习次数都还是 2（它们来自每日聚合，与卡片列表无关）
    expect(after.retention.total).toBe(2)
    expect(after.retention.rate).toBe(before.retention.rate)
    expect(after.heatmap.reduce((a, h) => a + h.count, 0)).toBe(2)
    expect(after.reviews.reduce((a, r) => a + r.total, 0)).toBe(2)
  })

  it('软删牌组与卡片自身软删是两回事：两者都排除，且不互相顶替', () => {
    const live = cardOf('live-1', 'keep')
    const deletedCard = { ...cardOf('dead-1', 'keep'), deletedAt: T0 }
    const hiddenDeck = cardOf('hidden-1', 'deleted')
    const s = computeStats({
      desiredRetention: 0.9,
      cards: [live, deletedCard, hiddenDeck],
      dailyAgg: new Map(),
      deckId: null,
      hiddenDeckIds: ['deleted'],
      range: 'year',
      now: T0 + DAY
    })
    expect(s.stateCounts.new).toBe(1)
  })
})

// 留存率与答题耗时：原先 StatsPayload 完全没有留存率，config.desiredRetention
// （默认 0.9，FSRS 的核心旋钮）在界面上无处可看；answer 事件里的 durationMs
// 也是只写不读。这里钉住口径：rate = 非重来 / 已答题（undo 已抵消）。
describe('留存率与答题耗时', () => {
  const ans = (seq: number, rating: Rating, extra: Partial<ReviewEvent> = {}): ReviewEvent => ({
    seq,
    t: T0,
    action: 'answer',
    cardId: 'c1',
    deckId: 'd1',
    rating,
    ...extra
  })

  it('rate = 非重来 / 已答题；Again 计入分母不计入分子', () => {
    const cards = [cardOf('c1')]
    const agg = aggOf([ans(1, 3), ans(2, 1), ans(3, 4), ans(4, 2)])
    const s = computeStats({
      desiredRetention: 0.9,
      cards,
      dailyAgg: agg,
      deckId: null,
      hiddenDeckIds: [],
      range: 'year',
      now: T0 + DAY
    })
    expect(s.retention.total).toBe(4)
    expect(s.retention.correct).toBe(3)
    expect(s.retention.rate).toBeCloseTo(0.75, 6)
    expect(s.retention.desired).toBe(0.9)
  })

  it('undo 抵消后留存率同步回落（撤销的 Again 不再拖低留存）', () => {
    const cards = [cardOf('c1')]
    const events = [ans(1, 3), ans(2, 1), ans(3, 3)]
    const undone = [...events, { seq: 4, t: T0, action: 'undo' as const, cardId: 'c1', deckId: 'd1', targetSeq: 2 }]
    const s0 = computeStats({
      desiredRetention: 0.9,
      cards,
      dailyAgg: aggOf(events),
      deckId: null,
      hiddenDeckIds: [],
      range: 'year',
      now: T0 + DAY
    })
    const s1 = computeStats({
      desiredRetention: 0.9,
      cards,
      dailyAgg: aggOf(undone),
      deckId: null,
      hiddenDeckIds: [],
      range: 'year',
      now: T0 + DAY
    })
    expect(s0.retention.rate).toBeCloseTo(2 / 3, 6)
    expect(s1.retention.total).toBe(2)
    expect(s1.retention.rate).toBe(1) // 那次 Again 被撤销了
  })

  it('范围内没有答题 → rate 为 null（不是 0，否则显示成「全忘了」）', () => {
    const s = computeStats({
      desiredRetention: 0.85,
      cards: [cardOf('c1')],
      dailyAgg: new Map(),
      deckId: null,
      hiddenDeckIds: [],
      range: 'year',
      now: T0
    })
    expect(s.retention.total).toBe(0)
    expect(s.retention.rate).toBeNull()
    expect(s.retention.avgAnswerMs).toBeNull()
    expect(s.retention.trend).toEqual([])
    expect(s.retention.desired).toBe(0.85)
  })

  it('平均答题耗时只除以「带耗时的次数」，缺耗时的答题不拉低均值', () => {
    const cards = [cardOf('c1')]
    // 三次带耗时（2s/4s/6s）+ 一次缺耗时（算 0 或 undefined）
    const agg = aggOf([
      ans(1, 3, { durationMs: 2000 }),
      ans(2, 3, { durationMs: 4000 }),
      ans(3, 1, { durationMs: 6000 }),
      ans(4, 3)
    ])
    const s = computeStats({
      desiredRetention: 0.9,
      cards,
      dailyAgg: agg,
      deckId: null,
      hiddenDeckIds: [],
      range: 'year',
      now: T0 + DAY
    })
    expect(s.retention.total).toBe(4)
    expect(s.retention.avgAnswerMs).toBe(4000) // (2000+4000+6000)/3，不是 /4
  })

  it('耗时为 0 / 负数（旧路径或时钟回拨）不计入均值分母', () => {
    const cards = [cardOf('c1')]
    const agg = aggOf([ans(1, 3, { durationMs: 0 }), ans(2, 3, { durationMs: -500 }), ans(3, 3, { durationMs: 3000 })])
    const s = computeStats({
      desiredRetention: 0.9,
      cards,
      dailyAgg: agg,
      deckId: null,
      hiddenDeckIds: [],
      range: 'year',
      now: T0 + DAY
    })
    expect(s.retention.avgAnswerMs).toBe(3000)
  })

  it('趋势只含有答题的分档，且与热力图/复习同一分档口径', () => {
    const cards = [cardOf('c1')]
    const agg = aggOf([ans(1, 3, { t: T0 }), ans(2, 1, { t: T0 }), ans(3, 3, { t: T0 + 2 * DAY })])
    const s = computeStats({
      desiredRetention: 0.9,
      cards,
      dailyAgg: agg,
      deckId: null,
      hiddenDeckIds: [],
      range: 'year',
      now: T0 + 3 * DAY
    })
    const nonEmpty = s.reviews.filter((r) => r.total > 0)
    expect(s.retention.trend.map((p) => p.label)).toEqual(nonEmpty.map((r) => r.label))
    const first = s.retention.trend.find((p) => p.total === 2)!
    expect(first.correct).toBe(1) // 一次 Again + 一次 Good
  })

  it('牌组过滤同样作用于留存率（只看该牌组）', () => {
    const cards = [cardOf('c1')]
    const agg: DailyAgg = new Map()
    bumpDailyAgg(agg, 'd1', T0, 3, 1)
    bumpDailyAgg(agg, 'd2', T0, 1, 1)
    bumpDailyAgg(agg, 'd2', T0, 1, 1)
    const all = computeStats({
      desiredRetention: 0.9,
      cards,
      dailyAgg: agg,
      deckId: null,
      hiddenDeckIds: [],
      range: 'year',
      now: T0 + DAY
    })
    const d1 = computeStats({
      desiredRetention: 0.9,
      cards,
      dailyAgg: agg,
      deckId: 'd1',
      hiddenDeckIds: [],
      range: 'year',
      now: T0 + DAY
    })
    expect(all.retention.rate).toBeCloseTo(1 / 3, 6)
    expect(d1.retention.total).toBe(1)
    expect(d1.retention.rate).toBe(1)
  })
})

describe('normalizeBucket（旧 stats.json 兼容）', () => {
  it('旧格式只有 total/again → correct 按 total-again 兜底，耗时项补 0', () => {
    expect(normalizeBucket({ total: 10, again: 3 })).toEqual({
      total: 10,
      again: 3,
      correct: 7,
      timed: 0,
      durationSumMs: 0
    })
  })

  it('新格式原样保留（不被兜底覆盖）', () => {
    expect(normalizeBucket({ total: 10, again: 3, correct: 6, timed: 2, durationSumMs: 5000 })).toEqual({
      total: 10,
      again: 3,
      correct: 6,
      timed: 2,
      durationSumMs: 5000
    })
  })

  it('缺字段/垃圾值不产生 NaN（NaN 会一路污染均值与百分比）', () => {
    const b = normalizeBucket({ total: undefined, again: 'x' as unknown as number })
    expect(b).toEqual({ total: 0, again: 0, correct: 0, timed: 0, durationSumMs: 0 })
    expect(Number.isNaN(b.total)).toBe(false)
  })

  it('旧格式下留存率仍然等于 (total-again)/total', () => {
    const cards = [cardOf('c1')]
    const agg: DailyAgg = new Map([['d1', new Map([['1970-01-02', normalizeBucket({ total: 4, again: 1 })]])]])
    const s = computeStats({
      desiredRetention: 0.9,
      cards,
      dailyAgg: agg,
      deckId: null,
      hiddenDeckIds: [],
      range: 'all',
      now: T0 + DAY
    })
    expect(s.retention.rate).toBeCloseTo(0.75, 6)
  })
})

describe('statsCacheKey：键与 computeStats 入参同源', () => {
  const base = (): StatsInput => ({
    cards: [],
    dailyAgg: new Map(),
    deckId: null,
    hiddenDeckIds: [],
    range: 'year',
    now: T0,
    desiredRetention: 0.9
  })

  it('每个被 computeStats 消费的输入都有一个进入键的维度', () => {
    const k = statsCacheKey(base(), 7)
    // deckId / range / 日期 / seq / desiredRetention —— 逐一改动都必须换键，
    // 否则「改了输入但命中旧缓存」就会退回成静默的过期结果
    expect(statsCacheKey({ ...base(), deckId: 'd1' }, 7)).not.toBe(k)
    expect(statsCacheKey({ ...base(), hiddenDeckIds: [], range: 'all' }, 7)).not.toBe(k)
    expect(statsCacheKey({ ...base(), now: T0 + DAY }, 7)).not.toBe(k)
    expect(statsCacheKey(base(), 8)).not.toBe(k)
    expect(statsCacheKey({ ...base(), desiredRetention: 0.8 }, 7)).not.toBe(k)
    // hiddenDeckIds 必须进键：删/恢复牌组不推 session.seq，不进键就会命中「删之前的旧统计」
    expect(statsCacheKey({ ...base(), hiddenDeckIds: ['d9'] }, 7)).not.toBe(k)
  })

  it('hiddenDeckIds 的键与顺序无关（同一个软删集合只算一个键）', () => {
    const a = statsCacheKey({ ...base(), hiddenDeckIds: ['d1', 'd2'] }, 7)
    const b = statsCacheKey({ ...base(), hiddenDeckIds: ['d2', 'd1'] }, 7)
    expect(a).toBe(b)
  })

  it('相同输入 → 相同键（缓存命中是有效的）', () => {
    expect(statsCacheKey(base(), 7)).toBe(statsCacheKey(base(), 7))
  })

  it('纯函数：不受调用时刻影响（now 由入参决定，不读 Date.now）', () => {
    const input = base()
    vi.useFakeTimers()
    try {
      const a = statsCacheKey(input, 7)
      vi.advanceTimersByTime(3 * DAY)
      expect(statsCacheKey(input, 7)).toBe(a)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cards / dailyAgg 刻意不进键（键只记身份，不遍历内容）', () => {
    const k = statsCacheKey(base(), 7)
    expect(statsCacheKey({ ...base(), cards: [cardOf('c1')] }, 7)).toBe(k)
  })
})
