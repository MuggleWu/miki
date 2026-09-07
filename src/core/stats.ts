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

  // 预测：38 根等宽柱自适应分桶（柱数沿用原 30 天 + 8 周；桶宽随视野均分，逾期积压与超远间隔都进图）
  const forecast: StatsPayload['forecast'] = []
  const FORECAST_BARS = 38
  const endOfToday = endOfLocalDay(now)
  // 暂停卡不进调度（与队列口径一致），不计入预测；逾期卡仅在「全部」档计入
  const scheduled = cards.filter((c) => !c.suspended && c.fsrs).map((c) => c.fsrs!.due)
  let fStart: number
  let fSpan: number
  if (range === 'all' && scheduled.length > 0) {
    // 全部：最远到期 − 最早逾期，跨度均分 38 桶（逾期积压落在最左侧柱）
    let minDue = Infinity
    let maxDue = -Infinity
    for (const due of scheduled) {
      if (due < minDue) minDue = due
      if (due > maxDue) maxDue = due
    }
    fStart = minDue
    fSpan = Math.max(maxDue - minDue, FORECAST_BARS)
  } else {
    // 近一年：未来 365 天均分 38 桶；无已调度卡时回退此窗口（全零柱）
    fStart = endOfToday
    fSpan = 365 * 86_400_000
  }
  const barWidth = fSpan / FORECAST_BARS
  const counts = new Array<number>(FORECAST_BARS).fill(0)
  for (const due of scheduled) {
    if (range === 'year' && (due <= fStart || due > fStart + fSpan)) continue // 逾期与超视野不计
    const bi = Math.min(FORECAST_BARS - 1, Math.max(0, Math.floor((due - fStart) / barWidth)))
    counts[bi]++
  }
  for (let i = 0; i < FORECAST_BARS; i++) {
    const rs = fStart + barWidth * i
    forecast.push({ label: forecastLabel(rs, barWidth), count: counts[i], range: forecastRange(rs, rs + barWidth, barWidth) })
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

/** 预测柱标签：桶宽 ≥1 年只标年份，≥25 天标年-月，否则标月-日 */
function forecastLabel(ms: number, barWidth: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  if (barWidth >= 365 * 86_400_000) return `${d.getFullYear()}`
  if (barWidth >= 25 * 86_400_000) return `${d.getFullYear()}-${p(d.getMonth() + 1)}`
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 预测柱 tooltip 区间文本：起止两端各格式化一次，按桶宽省略同侧重复 */
function forecastRange(rs: number, re: number, barWidth: number): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const fmt = (ms: number, withYear: boolean) => {
    const d = new Date(ms)
    const md = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    return withYear ? md : md.slice(5)
  }
  const withYear = barWidth >= 25 * 86_400_000
  if (barWidth < 86_400_000) return `${fmt(rs, false)} ${String(new Date(rs).getHours()).padStart(2, '0')}:00 起`
  return `${fmt(rs, withYear)} ~ ${fmt(re, withYear)}`
}
