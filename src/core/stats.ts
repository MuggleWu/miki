// 统计聚合（需求 §8 五板块口径 / §19 L1 事件不驻留）
import type { Card, Rating, StatsPayload } from '../shared/types'
import { FSRS_STATE } from '../shared/types'

const INTL_BUCKETS = ['<1d', '1-3', '4-7', '8-14', '15-30', '30+'] as const

/** 本地时区日期键 yyyy-MM-dd（热力图聚合与调度索引跨天检测共用） */
export function localDateKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 热力图聚合：deckId → 日期键 → {total, again}；由事件流式聚合（undo 已抵消），替代全量事件驻留 */
export type DailyAgg = Map<string, Map<string, { total: number; again: number }>>

/** 聚合计数（delta=1 答题 / -1 undo 抵消），唯一入口，流式重放与运行时共用 */
export function bumpDailyAgg(agg: DailyAgg, deckId: string, t: number, rating: Rating | undefined, delta: 1 | -1): void {
  let byDeck = agg.get(deckId)
  if (!byDeck) {
    byDeck = new Map()
    agg.set(deckId, byDeck)
  }
  const key = localDateKey(t)
  const c = byDeck.get(key) ?? { total: 0, again: 0 }
  c.total += delta
  if (rating === 1) c.again += delta
  byDeck.set(key, c)
}

export interface StatsInput {
  cards: Card[] // 未过滤的全量卡（函数内部按 deckId 过滤）
  dailyAgg: DailyAgg // 热力图聚合（undo 已抵消）
  deckId: string | null
  range: 'year' | 'all'
  now: number
}

export function computeStats(input: StatsInput): StatsPayload {
  const { deckId, range, now } = input
  const rangeStart = range === 'year' ? now - 365 * 86_400_000 : 0
  const startKey = range === 'year' ? localDateKey(rangeStart) : ''

  const deckOf = (deck: string) => deckId == null || deck === deckId
  const cards = input.cards.filter((c) => !c.deletedAt && deckOf(c.deckId))

  // 热力图 & 复习曲线（聚合已是净计数，按牌组过滤后合并）
  const dayCounts = new Map<string, { total: number; again: number }>()
  for (const [deck, days] of input.dailyAgg) {
    if (!deckOf(deck)) continue
    for (const [key, c] of days) {
      if (startKey && key < startKey) continue
      const cur = dayCounts.get(key) ?? { total: 0, again: 0 }
      cur.total += c.total
      cur.again += c.again
      dayCounts.set(key, cur)
    }
  }
  const heatmap: StatsPayload['heatmap'] = []
  const reviews: StatsPayload['reviews'] = []
  if (range === 'year') {
    const start = new Date(now - 364 * 86_400_000)
    start.setHours(0, 0, 0, 0)
    for (let t = start.getTime(); t <= now; t += 86_400_000) {
      const key = localDateKey(t)
      const c = dayCounts.get(key) ?? { total: 0, again: 0 }
      heatmap.push({ date: key, count: c.total })
      reviews.push({ label: key, total: c.total, again: c.again })
    }
  } else {
    // 全部：按月聚合
    const monthCounts = new Map<string, { total: number; again: number }>()
    for (const [key, c] of dayCounts) {
      const mk = key.slice(0, 7)
      const cur = monthCounts.get(mk) ?? { total: 0, again: 0 }
      cur.total += c.total
      cur.again += c.again
      monthCounts.set(mk, cur)
    }
    const months = [...monthCounts.keys()].sort()
    for (const mk of months) {
      const c = monthCounts.get(mk)!
      heatmap.push({ date: mk, count: c.total })
      reviews.push({ label: mk, total: c.total, again: c.again })
    }
  }

  // 预测：未来 30 天按天 + 第 5-12 周按周
  const forecast: StatsPayload['forecast'] = []
  const dueByDay = new Map<string, number>()
  const dueByWeek = new Map<string, number>()
  const endOfToday = endOfLocalDay(now)
  for (const c of cards) {
    if (!c.fsrs || c.fsrs.due <= endOfToday) continue
    if (c.fsrs.due <= endOfToday + 30 * 86_400_000) {
      const key = localDateKey(c.fsrs.due)
      dueByDay.set(key, (dueByDay.get(key) ?? 0) + 1)
    } else {
      const week = Math.floor((c.fsrs.due - endOfToday) / (7 * 86_400_000))
      const key = `W+${week}`
      dueByWeek.set(key, (dueByWeek.get(key) ?? 0) + 1)
    }
  }
  const start = new Date(endOfToday + 86_400_000)
  start.setHours(0, 0, 0, 0)
  for (let i = 0; i < 30; i++) {
    const t = start.getTime() + i * 86_400_000
    const key = localDateKey(t)
    forecast.push({ label: key.slice(5), count: dueByDay.get(key) ?? 0 })
  }
  for (let w = 5; w <= 12; w++) {
    forecast.push({ label: `+${w}w`, count: dueByWeek.get(`W+${w}`) ?? 0 })
  }

  // 状态分布
  const stateCounts = { new: 0, learning: 0, review: 0 }
  for (const c of cards) {
    if (!c.fsrs) stateCounts.new++
    else if (c.fsrs.state === FSRS_STATE.Review) stateCounts.review++
    else stateCounts.learning++
  }

  // 复习间隔分布（当前 Review 卡）
  const intervals: StatsPayload['intervals'] = INTL_BUCKETS.map((b) => ({ bucket: b, count: 0 }))
  const bounds = [1, 3, 7, 14, 30, Infinity]
  for (const c of cards) {
    const f = c.fsrs
    if (!f || f.state !== FSRS_STATE.Review || f.lastReview == null) continue
    const days = Math.max(1, Math.round((f.due - f.lastReview) / 86_400_000))
    const bi = bounds.findIndex((b) => days <= b)
    intervals[bi === -1 ? 5 : bi].count++
  }

  return { forecast, heatmap, reviews, stateCounts, intervals }
}

export function endOfLocalDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(23, 59, 59, 999)
  return d.getTime()
}
