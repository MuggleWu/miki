// 统计账本：热力图聚合 + 今日/累计答题计数 + 结果缓存。
//
// 从 WorkspaceService 拆出（原先散落 6 个字段、十几处赋值）：这三样东西共用「seq 单调推进」
// 与「undo 精确抵消」两条不变量，散在工作区里改一处漏一处的风险高（本次审计就在 undo
// 路径上漏传过 durationMs，导致均耗时虚高）。收成一个类后：
//   - 记一次答题 = recordAnswer 一个调用（聚合 + 今日 + 累计三处同步推进）；
//   - 抵消一次 = undoAnswer（三处同步回退 + seq 水位判断）；
//   - 缓存失效集中成 invalidate（谁都必须调，而不是各自记得 clear）。
import * as fs from 'node:fs'
import {
  bumpDailyAgg,
  computeStats,
  localDateKey,
  normalizeBucket,
  statsCacheKey,
  type DailyAgg,
  type DailyBucket
} from '../core/stats'
import type { Card, Rating, StatsParams, StatsPayload } from '../shared/types'
import type { WorkspacePaths } from './workspace-io'
import { atomicWrite } from './atomic-write'

/** stats.json 里 dailyAgg 的序列化形态（旧格式缺 correct/timed/durationSumMs，靠 normalizeBucket 补） */
export type PersistedDailyAgg = [string, [string, Partial<DailyBucket>][]][]

/** 一天的起止（跨天清零与「今日」判定用；由调用方注入以便测试固定时间） */
export interface DayContext {
  /** 该时刻所在日的本地日期键 yyyy-MM-dd */
  dayKeyOf(t: number): string
  /** 「今日」的起始毫秒（undo 抵消今日计数时的判定边界） */
  todayStartMs(): number
}

export class StatsLedger {
  /** 热力图聚合（undo 已抵消）：deckId → 日期键 → 单日计数 */
  private dailyAgg: DailyAgg = new Map()
  /** 聚合检查点 seq（stats.json 已包含该 seq 及之前的贡献；重放时只看它之后的事件） */
  private checkpoint = 0
  /** 今日已答净计数（答题 ++ / 撤销抵消 -- / 跨天清零） */
  private todayAnswers = 0
  /** 历史累计净答题数：dailyAgg 全部 total 的运行镜像（启动算一次，之后增量维护），免去每次全量遍历聚合 */
  private totalAnswered = 0
  /** 结果缓存：computeStats 是全库扫描，统计页每次开/切条件都要重付；上限 8 组，超出即全清 */
  private cache = new Map<string, StatsPayload>()

  constructor(
    private readonly paths: WorkspacePaths,
    private readonly day: DayContext
  ) {}

  // ---------- 只读 ----------

  /** stats.json 已覆盖到的事件水位：重放只需处理比它新的事件 */
  get checkpointSeq(): number {
    return this.checkpoint
  }

  todayCount(): number {
    return this.todayAnswers
  }

  totalAnsweredCount(): number {
    return this.totalAnswered
  }

  /** 供 computeStats 直接消费（调用方不要改这份聚合） */
  get aggregate(): DailyAgg {
    return this.dailyAgg
  }

  // ---------- 写入 ----------

  /**
   * 记一次答题：聚合、今日、累计三处同步推进。
   * durationMs 只在真的上报过的答题上计入（0/负值视为未上报，避免虚高均耗时）。
   */
  recordAnswer(deckId: string, t: number, rating: Rating | undefined, durationMs?: number): void {
    bumpDailyAgg(this.dailyAgg, deckId, t, rating, 1, durationMs)
    if (this.day.dayKeyOf(t) === localDateKey(Date.now())) this.todayAnswers++
    this.totalAnswered++
  }

  /**
   * 抵消一次答题（undo）：与 recordAnswer 严格镜像。
   * 今日计数用「事件时间 >= 今日起点」判定，与 recordAnswer 的日期键判定等价
   * （两者的差别只在跨天瞬间的边界，测试里两条路径都有覆盖）。
   */
  undoAnswer(deckId: string, t: number, rating: Rating | undefined, durationMs?: number): void {
    bumpDailyAgg(this.dailyAgg, deckId, t, rating, -1, durationMs)
    if (t >= this.day.todayStartMs()) this.todayAnswers--
    this.totalAnswered--
  }

  /** 跨天清零今日计数（累计数与聚合跨天不变） */
  clearToday(): void {
    this.todayAnswers = 0
  }

  /** 作废结果缓存。加卡/移卡不走事件（不推 seq），缓存键感知不到，必须显式调用 */
  invalidate(): void {
    this.cache.clear()
  }

  // ---------- 检查点 ----------

  /**
   * 读 stats.json（缺失/损坏 → 聚合清零，由调用方全量重放，语义无损）。
   * 今日计数与累计数直接从聚合重导：聚合已含 undo 抵消，比重放计数更可靠。
   */
  loadCheckpoint(): void {
    this.dailyAgg = new Map()
    this.checkpoint = 0
    this.todayAnswers = 0
    this.totalAnswered = 0
    this.cache = new Map() // 冷启动/热加载共用此链：聚合与 seq 全部重建，旧缓存一律作废
    const file = this.paths.statsFile()
    if (!fs.existsSync(file)) return
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
        checkpointSeq?: number
        dailyAgg?: PersistedDailyAgg
      }
      this.checkpoint = Number(raw.checkpointSeq) || 0
      for (const [deckId, days] of raw.dailyAgg ?? []) {
        this.dailyAgg.set(deckId, new Map(days.map(([k, c]) => [k, normalizeBucket(c)])))
      }
      const tk = localDateKey(Date.now())
      let today = 0
      let total = 0
      for (const m of this.dailyAgg.values()) {
        for (const c of m.values()) total += c.total
        today += m.get(tk)?.total ?? 0
      }
      this.todayAnswers = today
      this.totalAnswered = total
    } catch {
      // 损坏：清空后由调用方全量重放补回（多读一遍事件，语义无损）
      this.dailyAgg = new Map()
      this.checkpoint = 0
      this.todayAnswers = 0
      this.totalAnswered = 0
    }
  }

  /** 检查点落盘（压实时调用；运行期不写，避免高频重写） */
  saveCheckpoint(seq: number): void {
    const daily: PersistedDailyAgg = [...this.dailyAgg].map(([d, m]) => [d, [...m]])
    atomicWrite(this.paths.statsFile(), JSON.stringify({ checkpointSeq: seq, dailyAgg: daily }))
  }

  /** 压实后水位推进到当前 seq：此后重放不再重复计算已进聚合的事件 */
  advanceCheckpoint(seq: number): void {
    this.checkpoint = seq
  }

  // ---------- 查询 ----------

  /**
   * 统计结果（带缓存）。缓存键不再手写字段清单，而是由送进 computeStats 的入参直接生成
   * （见 statsCacheKey）：缓存键漏字段是「结果悄悄过期」这类 bug 的固定来源——本次审计就
   * 撞到过 desiredRetention 没进键、改设置后统计页一直显示旧目标值。键与入参同源后，
   * 以后往 computeStats 加输入，键自动跟上，不需要记得同步改两处。
   */
  query(params: StatsParams, ctx: { cards: Iterable<Card>; seq: number; desiredRetention: number }): StatsPayload {
    const input = {
      cards: ctx.cards,
      dailyAgg: this.dailyAgg,
      deckId: params.deckId,
      range: params.range,
      now: Date.now(),
      desiredRetention: ctx.desiredRetention
    }
    const key = statsCacheKey(input, ctx.seq)
    const hit = this.cache.get(key)
    if (hit) return hit
    const payload = computeStats(input)
    if (this.cache.size >= 8) this.cache.clear()
    this.cache.set(key, payload)
    return payload
  }
}
