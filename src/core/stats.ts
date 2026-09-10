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

/** 单日聚合：总量 / 重来 / 答对（非 Again）/ 答题耗时和（仅计已上报耗时的次数） */
export interface DailyBucket {
  total: number
  again: number
  correct: number
  /** 已上报 durationMs 的答题次数（耗时为 0 的旧路径不计，故均值分母是它而非 total） */
  timed: number
  durationSumMs: number
}

/** 热力图聚合：deckId → 日期键 → 单日聚合；由事件流式聚合（undo 已抵消），替代全量事件驻留 */
export type DailyAgg = Map<string, Map<string, DailyBucket>>

const emptyBucket = (): DailyBucket => ({ total: 0, again: 0, correct: 0, timed: 0, durationSumMs: 0 })

/**
 * 旧格式补全：加入 correct/timed 之前落盘的 stats.json 只有 {total, again}，缺项按 0 补。
 * 历史 correct 无法反推（没记 rating 分布），按 total - again 兜底——这样历史数据的
 * 留存率 = (total-again)/total 仍然成立，只是「答对」在数值上等价于「没按重来」。
 */
export function normalizeBucket(c: Partial<DailyBucket> | undefined): DailyBucket {
  const total = Number(c?.total) || 0
  const again = Number(c?.again) || 0
  return {
    total,
    again,
    correct: typeof c?.correct === 'number' ? Number(c.correct) : Math.max(0, total - again),
    timed: Number(c?.timed) || 0,
    durationSumMs: Number(c?.durationSumMs) || 0
  }
}

/** 聚合计数（delta=1 答题 / -1 undo 抵消），唯一入口，流式重放与运行时共用 */
export function bumpDailyAgg(
  agg: DailyAgg,
  deckId: string,
  t: number,
  rating: Rating | undefined,
  delta: 1 | -1,
  durationMs?: number
): void {
  let byDeck = agg.get(deckId)
  if (!byDeck) {
    byDeck = new Map()
    agg.set(deckId, byDeck)
  }
  const key = localDateKey(t)
  const c = byDeck.get(key) ?? emptyBucket()
  c.total += delta
  if (rating === 1) c.again += delta
  else if (rating !== undefined) c.correct += delta
  if (typeof durationMs === 'number' && durationMs > 0) {
    c.timed += delta
    c.durationSumMs += delta * durationMs
  }
  byDeck.set(key, c)
}

export interface StatsInput {
  /** 未过滤的全量卡（函数内部按 deckId 过滤）；接受 Iterable，调用方可直接传 Map.values() 免去整库拷贝 */
  cards: Iterable<Card>
  dailyAgg: DailyAgg // 热力图聚合（undo 已抵消）
  deckId: string | null
  range: 'year' | 'all'
  now: number
  /** 目标留存率（config.desiredRetention），用于与实测对比展示 */
  desiredRetention: number
}

/**
 * 统计结果缓存键。刻意放在 StatsInput 定义旁边、并且显式列出每个进结果的输入：
 * 缓存键漏字段是「结果悄悄过期」这类 bug 的固定来源（本次审计撞到过 desiredRetention
 * 漏进键、改设置后统计页一直显示旧目标值）。写在这里的另一个好处是——往 StatsInput
 * 加字段时，类型检查会把这个函数标红，逼着人决定新输入要不要进键；若只想加一个
 * 「不影响结果」的字段，在下面补一行说明为什么它不进键。
 *
 * seq 是调度事件水位（调用方状态，非 StatsInput 成员）：同 seq 同日内结果确定。
 */
export function statsCacheKey(input: StatsInput, seq: number): string {
  // 日期键用 input.now 而非 Date.now()：固定 now 的调用（测试）与真实调用同样是纯函数
  return `${input.deckId ?? ''}|${input.range}|${localDateKey(input.now)}|${seq}|${input.desiredRetention}`
}

export function computeStats(input: StatsInput): StatsPayload {
  const { deckId, range, now } = input
  const rangeStart = range === 'year' ? now - 365 * 86_400_000 : 0
  const startKey = range === 'year' ? localDateKey(rangeStart) : ''

  const deckOf = (deck: string) => deckId == null || deck === deckId
  const cards: Card[] = []
  for (const c of input.cards) {
    if (!c.deletedAt && deckOf(c.deckId)) cards.push(c)
  }

  // 热力图 & 复习曲线（聚合已是净计数，按牌组过滤后合并）
  const dayCounts = new Map<string, DailyBucket>()
  for (const [deck, days] of input.dailyAgg) {
    if (!deckOf(deck)) continue
    for (const [key, c] of days) {
      if (startKey && key < startKey) continue
      const cur = dayCounts.get(key) ?? emptyBucket()
      cur.total += c.total
      cur.again += c.again
      cur.correct += c.correct
      cur.timed += c.timed
      cur.durationSumMs += c.durationSumMs
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
      const c = dayCounts.get(key) ?? emptyBucket()
      heatmap.push({ date: key, count: c.total })
      reviews.push({ label: key, total: c.total, again: c.again })
    }
  } else {
    // 全部：按月聚合
    const monthCounts = new Map<string, DailyBucket>()
    for (const [key, c] of dayCounts) {
      const mk = key.slice(0, 7)
      const cur = monthCounts.get(mk) ?? emptyBucket()
      cur.total += c.total
      cur.again += c.again
      cur.correct += c.correct
      cur.timed += c.timed
      cur.durationSumMs += c.durationSumMs
      monthCounts.set(mk, cur)
    }
    const months = [...monthCounts.keys()].sort()
    for (const mk of months) {
      const c = monthCounts.get(mk)!
      heatmap.push({ date: mk, count: c.total })
      reviews.push({ label: mk, total: c.total, again: c.again })
    }
  }

  // 留存率：范围口径 = 该范围内所有已答的净计数（undo 已抵消）。
  // 只统计「安排过的复习」才有意义的说法在 v1 不成立（没记录 到期/新卡 之分），
  // 所以这里如实标注为「已答题中评非重来的比例」，即 1 - Again 率。
  let rTotal = 0
  let rCorrect = 0
  let rTimed = 0
  let rDuration = 0
  for (const c of dayCounts.values()) {
    rTotal += c.total
    rCorrect += c.correct
    rTimed += c.timed
    rDuration += c.durationSumMs
  }
  const retention = {
    total: rTotal,
    correct: rCorrect,
    /** null = 范围内没有答题（不显示 0%，否则会误读成全忘了） */
    rate: rTotal > 0 ? rCorrect / rTotal : null,
    /** 平均单卡答题耗时（ms）；null = 范围内没有带耗时的答题 */
    avgAnswerMs: rTimed > 0 ? rDuration / rTimed : null,
    /** 目标留存率（与实测对比；口径差异见 docs） */
    desired: input.desiredRetention,
    /** 趋势点：与热力图/复习同一分档（近一年按天、全部按月），仅给有答题的分档 */
    trend: reviews
      .filter((r) => r.total > 0)
      .map((r) => ({ label: r.label, total: r.total, correct: r.total - r.again }))
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
    forecast.push({
      label: forecastLabel(rs, barWidth),
      count: counts[i],
      range: forecastRange(rs, rs + barWidth, barWidth)
    })
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

  return { forecast, heatmap, reviews, stateCounts, intervals, retention }
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
