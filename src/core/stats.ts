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
  /** 未过滤的全量卡（函数内部按 deckId 与 hiddenDeckIds 过滤）；接受 Iterable，调用方可直接传 Map.values() 免去整库拷贝 */
  cards: Iterable<Card>
  dailyAgg: DailyAgg // 热力图聚合（undo 已抵消）
  deckId: string | null
  /** 软删牌组的 id（升序，进缓存键）：其下卡片按「卡片库/首页」的同一口径排除。
   * 只影响由卡片列表派生的统计——状态分布、间隔分布、预测。留存率/平均耗时/热力图/
   * 复习次数都源自每日聚合（dayCounts），是「当天答过什么」的既成事实，不因删牌组而消失 */
  hiddenDeckIds: readonly string[]
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
  // hiddenDeckIds 进键：删/恢复牌组不推 session.seq，不进键就会命中「删之前的旧统计」。
  // 键内排序：同一个软删集合无论传入顺序如何都算一个键，不靠调用方自觉（缓存白做的坑）
  const hiddenKey = [...input.hiddenDeckIds].sort().join(',')
  return `${input.deckId ?? ''}|${input.range}|${localDateKey(input.now)}|${seq}|${input.desiredRetention}|${hiddenKey}`
}

export function computeStats(input: StatsInput): StatsPayload {
  const { deckId, range, now } = input
  const rangeStart = range === 'year' ? now - 365 * 86_400_000 : 0
  const startKey = range === 'year' ? localDateKey(rangeStart) : ''

  const deckOf = (deck: string) => deckId == null || deck === deckId
  // 软删牌组的卡片与卡片库/首页同口径排除（schedule-index 的 hiddenDeckIds 分支同理）
  const hidden = new Set(input.hiddenDeckIds)
  const cards: Card[] = []
  for (const c of input.cards) {
    if (!c.deletedAt && !hidden.has(c.deckId) && deckOf(c.deckId)) cards.push(c)
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

  // 预测（未来到期）：分档口径与「复习」图完全对齐——近一年＝未来 365 天每天一根，全部＝按月。
  // 逾期积压并进第一根（今天/本月）：旧的 38 根等宽柱每根跨 9.6 天、还把逾期整个丢掉，
  // 结果第一根柱（标签写的还是今天）比首页「到期」大十几倍，而且窗口每天往前滑 ⇒ 只增不减，
  // 从图上读不出「每天要刷多少」。按天之后柱高就是当天到期张数，和首页、和产能都对得上。
  const forecast: StatsPayload['forecast'] = []
  // 暂停卡不进调度（与队列口径一致），不计入预测
  const scheduled = cards.filter((c) => !c.suspended && c.fsrs).map((c) => c.fsrs!.due)
  if (range === 'year') {
    const days = nextLocalDays(now, FORECAST_DAYS)
    const indexOfDay = new Map<string, number>()
    days.forEach((ms, i) => indexOfDay.set(localDateKey(ms), i))
    const todayKey = localDateKey(days[0])
    const counts = new Array<number>(days.length).fill(0)
    let overdue = 0
    for (const due of scheduled) {
      const key = localDateKey(due)
      const i = indexOfDay.get(key)
      if (i !== undefined) {
        counts[i]++
        continue
      }
      // 逾期（含今天更早到点的）落到今天这一根：藏起来的话，图上永远看不到真实工作量
      if (key < todayKey) {
        counts[0]++
        overdue++
      }
      // key 在最后一天之后＝到期在一年以外，本档不画（视野与「近一年」一致）
    }
    for (let i = 0; i < days.length; i++) {
      forecast.push({
        label: monthDayLabel(days[i]),
        count: counts[i],
        range:
          i === 0 && overdue > 0 ? `${fullDayLabel(days[i])}（今天，另含逾期 ${overdue} 张）` : fullDayLabel(days[i])
      })
    }
  } else {
    const months = forecastMonths(now, scheduled)
    const indexOfMonth = new Map<string, number>()
    months.forEach((key, i) => indexOfMonth.set(key, i))
    const thisMonth = monthKey(now)
    const counts = new Array<number>(months.length).fill(0)
    let overdue = 0
    for (const due of scheduled) {
      const key = monthKey(due)
      const i = indexOfMonth.get(key)
      if (i !== undefined) {
        counts[i]++
        continue
      }
      if (key < thisMonth) {
        counts[0]++
        overdue++
      }
    }
    for (let i = 0; i < months.length; i++) {
      forecast.push({
        label: months[i],
        count: counts[i],
        range: i === 0 && overdue > 0 ? `${months[i]}（本月，另含逾期 ${overdue} 张）` : months[i]
      })
    }
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

/** 预测「近一年」档的天数：今天起 365 天，一天一根 */
const FORECAST_DAYS = 365
/** 预测「全部」档最少画几个月：没有远期卡时也不至于只剩一根柱 */
const FORECAST_MIN_MONTHS = 12
/** 预测「全部」档最多画几个月：极端数据（最远到期在几十年后）不至于把图撑成一片头发 */
const FORECAST_MAX_MONTHS = 120

/** 从 now 所在日起连续 n 个本地零点（跨 DST 用 setDate 递增，不按毫秒累加） */
function nextLocalDays(now: number, n: number): number[] {
  const out: number[] = []
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  for (let i = 0; i < n; i++) {
    out.push(d.getTime())
    d.setDate(d.getDate() + 1)
  }
  return out
}

/** 本地月键 yyyy-MM（「全部」档按它分桶；字符串比较即时间顺序，前提是月份补零） */
function monthKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 「全部」档的月份列表：本月起，到最远到期所在月；不足 12 个月补足，最多 120 个月 */
function forecastMonths(now: number, dues: readonly number[]): string[] {
  let lastMonth = monthKey(now)
  for (const due of dues) {
    const key = monthKey(due)
    if (key > lastMonth) lastMonth = key
  }
  const cursor = new Date(now)
  cursor.setDate(1)
  cursor.setHours(0, 0, 0, 0)
  const out: string[] = []
  while (out.length < FORECAST_MAX_MONTHS) {
    const key = monthKey(cursor.getTime())
    if (out.length >= FORECAST_MIN_MONTHS && key > lastMonth) break
    out.push(key)
    cursor.setMonth(cursor.getMonth() + 1)
  }
  return out
}

/** 预测柱标签：按天标「月-日」（与「复习」图同款，年由 tooltip 补） */
function monthDayLabel(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 预测柱 tooltip 文本：带年份与星期，避开「10-25」这种跨年就分不清的读法 */
function fullDayLabel(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}（周${'日一二三四五六'[d.getDay()]}）`
}
