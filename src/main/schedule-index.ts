// 牌组调度索引：due 最小堆 + 增量计数器，学习页/首页读 O(log n)（需求 §19 L1）。
// 索引只拥有 idx / indexDayKey / tie 计数器；卡库与牌组卡桶经 Host 每次取当前值——
// 热加载会整体替换 cards/byDeck 的 Map 实例，绝不能在构造时快照引用。
import { MinHeap, type HeapEntry } from '../core/min-heap'
import { displayState } from '../core/query'
import { endOfLocalDay, localDateKey } from '../core/stats'
import type { Card } from '../shared/types'

/** 单牌组索引：learning/review/fresh 三堆 + 口径分明的计数器 */
export interface DeckIndex {
  /** Learning/Relearning 态卡，key = due */
  learning: MinHeap
  /** Review 态卡，key = due */
  review: MinHeap
  /** 新卡，key = createdAt */
  fresh: MinHeap
  counts: {
    /** 首页「总数」列：未删卡（含暂停卡），与浏览器口径一致 */
    total: number
    new: number
    learningAll: number
    learningDueToday: number
    reviewDueToday: number
  }
  /** 堆是否已构建：init/跨天重建只建计数器（首页/统计够用），堆推迟到首次取卡时全量构建 */
  built: boolean
  /** 估算堆内死条目数（卡状态变更后旧条目未删，惰性失效遗留）：超半堆触发全量重灌，均摊 O(1) */
  stale: number
}

export interface ScheduleIndexHost {
  /** 全库卡（含软删/暂停卡，索引内部自行过滤）；热加载后是全新 Map 实例 */
  cards(): Map<string, Card>
  /** 牌组卡桶（含软删卡，索引内部自行过滤）；同上 */
  bucket(deckId: string): Card[] | undefined
  /** 软删牌组 id 集：这些牌组下的卡不算学习计数、不进学习队列（服务层缓存） */
  hiddenDeckIds(): Set<string>
  /** 会话内跨天（ensureDay 检出日期变化）时回调：服务层借此清零今日净计数 */
  onDayRollover(): void
}

export class ScheduleIndex {
  private idx = new Map<string, DeckIndex>()
  private indexDayKey = ''
  private orderCounter = 0

  constructor(private host: ScheduleIndexHost) {}

  /** 取牌组索引条目，不存在则建空索引（只建计数器；首页读 built/counts 用） */
  deckIdx(deckId: string): DeckIndex {
    let x = this.idx.get(deckId)
    if (!x) {
      x = {
        learning: new MinHeap(),
        review: new MinHeap(),
        fresh: new MinHeap(),
        counts: { total: 0, new: 0, learningAll: 0, learningDueToday: 0, reviewDueToday: 0 },
        built: false,
        stale: 0
      }
      this.idx.set(deckId, x)
    }
    return x
  }

  /** 跨天检测：日期变化时全量重建索引（重建同时自愈任何计数漂移）；会话内跨天回调宿主清今日净计数 */
  ensureDay(now = Date.now()): void {
    const k = localDateKey(now)
    if (k === this.indexDayKey) return
    const had = this.indexDayKey !== ''
    this.indexDayKey = k
    this.rebuildIndexes(now)
    if (had) this.host.onDayRollover()
  }

  /** 热加载专用：直接采纳日期键并全量重建（不走跨天清零语义，todayAnswers 由重载链从聚合重导） */
  forceRebuild(dayKey: string, now: number): void {
    this.indexDayKey = dayKey
    this.rebuildIndexes(now)
  }

  private rebuildIndexes(now: number): void {
    const eot = endOfLocalDay(now)
    this.idx = new Map()
    const hidden = this.host.hiddenDeckIds()
    let tie = 0
    for (const c of this.host.cards().values()) {
      c.tie = tie++ // tie 全量分配（含排除卡），保持与 Map 插入序一致
      if (c.deletedAt || hidden.has(c.deckId)) continue
      const ix = this.deckIdx(c.deckId)
      if (c.suspended) {
        ix.counts.total++ // 暂停卡不计学习计数，但仍是牌组成员（进总数）
        continue
      }
      this.classPush(c, ix, eot)
    }
    this.orderCounter = tie
  }

  /** 按当前状态加计数 +（堆已构建时）入堆（调用方保证卡未删未暂停、牌组未删）；tie 取卡上分配好的插入序 */
  private classPush(c: Card, ix: DeckIndex, eot: number): void {
    if (c.tie == null) c.tie = ++this.orderCounter
    ix.counts.total++
    const st = displayState(c)
    if (st === 'new') {
      ix.counts.new++
      if (ix.built) ix.fresh.push({ key: c.createdAt, tie: c.tie, id: c.id })
      return
    }
    const due = c.fsrs!.due
    if (st === 'review') {
      if (due <= eot) ix.counts.reviewDueToday++
      if (ix.built) ix.review.push({ key: due, tie: c.tie, id: c.id })
      return
    }
    ix.counts.learningAll++
    if (due <= eot) ix.counts.learningDueToday++
    if (ix.built) ix.learning.push({ key: due, tie: c.tie, id: c.id })
  }

  /** 仅入堆不计数（ensureBuilt 专用，计数已就绪） */
  private pushOnly(c: Card, ix: DeckIndex): void {
    if (c.tie == null) c.tie = ++this.orderCounter
    const st = displayState(c)
    if (st === 'new') {
      ix.fresh.push({ key: c.createdAt, tie: c.tie, id: c.id })
      return
    }
    const due = c.fsrs!.due
    if (st === 'review') {
      ix.review.push({ key: due, tie: c.tie, id: c.id })
      return
    }
    ix.learning.push({ key: due, tie: c.tie, id: c.id })
  }

  /** 首次取卡前构建该牌组的堆（init 只建计数器，首次进学习页才付建堆成本）；取卡走牌组卡桶，不扫全库 */
  private ensureBuilt(deckId: string): DeckIndex {
    const ix = this.deckIdx(deckId)
    if (ix.built) return ix
    ix.built = true
    const hidden = this.host.hiddenDeckIds()
    for (const c of this.host.bucket(deckId) ?? []) {
      if (c.deletedAt || c.suspended || hidden.has(c.deckId)) continue
      if (c.tie == null) c.tie = ++this.orderCounter
      this.pushOnly(c, ix)
    }
    return ix
  }

  /** 堆死条目（状态变更后旧条目惰性失效遗留）过半时全量重灌三堆：只重建堆不动计数器，
   * 每次状态变更最多 +1 死条目，重灌 O(牌组卡数)，过半阈值摊销后均摊 O(log n)；
   * 小堆（≤32 条目）不折腾，死条目顺带由 heapNext 弹出清理 */
  private rebuildHeapsIfStale(deckId: string, ix: DeckIndex): void {
    const total = ix.learning.size + ix.review.size + ix.fresh.size
    if (ix.stale <= 32 || ix.stale * 2 <= total) return
    if (this.host.hiddenDeckIds().has(deckId)) return // 隐藏牌组不取卡：堆内容保持现状，dueNowOf 口径不变
    ix.learning = new MinHeap()
    ix.review = new MinHeap()
    ix.fresh = new MinHeap()
    ix.stale = 0
    const hidden = this.host.hiddenDeckIds()
    for (const c of this.host.bucket(deckId) ?? []) {
      if (c.deletedAt || c.suspended || hidden.has(c.deckId)) continue
      this.pushOnly(c, ix)
    }
  }

  /** 按变更前状态减计数（堆条目不删，弹出时惰性失效）。总数只排除已删除卡（暂停卡仍是牌组成员）；学习/复习计数连暂停一起排除 */
  private unclassCounts(before: Card, eot: number, deckId: string): void {
    const ix = this.deckIdx(deckId)
    if (!before.deletedAt) ix.counts.total--
    if (before.deletedAt || before.suspended) return
    // 该卡变更前有一条活堆条目（未删未暂停、牌组未隐藏——隐藏牌组的卡从未入堆），状态一变即成死条目
    if (ix.built && !this.host.hiddenDeckIds().has(deckId)) ix.stale++
    const st = displayState(before)
    if (st === 'new') {
      ix.counts.new--
      return
    }
    const due = before.fsrs!.due
    if (st === 'review') {
      if (due <= eot) ix.counts.reviewDueToday--
      return
    }
    ix.counts.learningAll--
    if (due <= eot) ix.counts.learningDueToday--
  }

  /** 任一状态变化点统一调用：先跨天检测（会话内跨天经回调清今日净计数），再减掉变更前贡献、按新状态重新入堆计数（deckIdBefore 供移动跨牌组扣减） */
  reindexCard(card: Card, before: Card | null, deckIdBefore?: string): void {
    const now = Date.now()
    this.ensureDay(now)
    const eot = endOfLocalDay(now)
    if (before) this.unclassCounts(before, eot, deckIdBefore ?? before.deckId)
    const hidden = this.host.hiddenDeckIds()
    if (!card.deletedAt && !hidden.has(card.deckId)) {
      if (card.suspended) {
        this.deckIdx(card.deckId).counts.total++ // 暂停卡只进总数，学习/复习计数不含它
      } else {
        this.classPush(card, this.deckIdx(card.deckId), eot)
      }
    }
  }

  /** 批量新增卡统一入口（服务层 addCards 用）：与逐卡 reindexCard 同口径，公共量 hoist——
   * 先跨天检测，再一次性按新卡状态计数入堆（新卡 deletedAt=null 且未暂停） */
  addCardsNew(deckId: string, cards: Card[], now: number): void {
    this.ensureDay(now)
    const eot = endOfLocalDay(now)
    if (this.host.hiddenDeckIds().has(deckId)) return
    const ix = this.deckIdx(deckId)
    for (const c of cards) this.classPush(c, ix, eot)
  }

  /** 取堆顶有效卡：跳过失效条目（已删/暂停/换牌组/due 已变），dueLimit 内未到期则返回 null。
   * 有效卡只 peek 不 pop——pickNext 是幂等读，条目在卡片状态变化后按 key 不匹配惰性失效。 */
  private heapNext(
    h: MinHeap,
    deckId: string,
    dueLimit: number | null,
    match: (c: Card, e: HeapEntry) => boolean
  ): Card | null {
    while (h.size > 0) {
      const e = h.peek() as HeapEntry
      const card = this.host.cards().get(e.id)
      if (!card || card.deletedAt || card.suspended || card.deckId !== deckId || !match(card, e)) {
        h.pop()
        continue
      }
      if (dueLimit != null && e.key > dueLimit) return null
      return card
    }
    return null
  }

  /** 学习页取下一张卡：learning → 当日到期 review → 新卡 */
  pickNextIdx(deckId: string, now: number): Card | null {
    const ix = this.ensureBuilt(deckId)
    this.rebuildHeapsIfStale(deckId, ix)
    const learning = this.heapNext(
      ix.learning,
      deckId,
      now,
      (c, e) => !!c.fsrs && displayState(c) === 'learning' && c.fsrs!.due === e.key
    )
    if (learning) return learning
    // 刷完旧卡才能刷新卡：当日会到期的复习卡（含今日稍后到点）都先于新卡出
    const eot = endOfLocalDay(now)
    const review = this.heapNext(
      ix.review,
      deckId,
      eot,
      (c, e) => displayState(c) === 'review' && c.fsrs!.due === e.key
    )
    if (review) return review
    return this.heapNext(ix.fresh, deckId, null, (c, e) => !c.fsrs && c.createdAt === e.key)
  }

  /** 学习页剩余数：新卡 + 今日到期学习 + 今日到期复习 */
  remainingOf(deckId: string): number {
    const ix = this.deckIdx(deckId)
    return ix.counts.new + ix.counts.learningDueToday + ix.counts.reviewDueToday
  }

  /** 「到期」列：此刻 due <= now 的学习/复习卡数（不含新卡/未到期/暂停卡）。到期随时间推进无法增量维护，读时计算——
   * 堆已构建时从根 DFS，key > now 剪枝（堆性质：子节点 key >= 父节点）；条目可能含失效/重复（惰性失效遗留），按卡 id 去重后以卡的真实 due 判定。
   * 未构建时走该牌组的卡桶单趟扫描。 */
  dueNowOf(deckId: string, ix: DeckIndex): number {
    const now = Date.now()
    if (!ix.built) {
      const hidden = this.host.hiddenDeckIds()
      let n = 0
      for (const c of this.host.bucket(deckId) ?? []) {
        if (c.deletedAt || c.suspended || hidden.has(c.deckId)) continue
        if (c.fsrs && c.fsrs.due <= now) n++
      }
      return n
    }
    this.rebuildHeapsIfStale(deckId, ix)
    const seen = new Set<string>()
    let n = 0
    for (const h of [ix.learning, ix.review]) {
      const stack = [0]
      while (stack.length > 0) {
        const i = stack.pop()!
        const e = h.at(i)
        if (!e || e.key > now) continue
        const c = this.host.cards().get(e.id)
        if (c && !c.deletedAt && !c.suspended && c.deckId === deckId && !seen.has(c.id)) {
          seen.add(c.id)
          if (c.fsrs && c.fsrs.due <= now) n++
        }
        stack.push(2 * i + 1, 2 * i + 2)
      }
    }
    return n
  }
}
