// 学习队列（需求 §5，D3 不限额）：到点的旧卡优先，新卡其次，都取不到就没有卡可出
// 身份：测试对照 oracle，不是生产路径——生产出卡/计数走 shared/schedule-index.ts 的三堆索引；
// core.spec 与 schedule-index.spec 用这里的线性实现校验堆索引语义一致。改出卡口径时两边必须同步。
import type { Card, DeckCounts } from '../shared/types'
import { FSRS_STATE } from '../shared/types'

export function isLearningDue(card: Card, now: number): boolean {
  return !card.deletedAt && !!card.fsrs && card.fsrs.state !== FSRS_STATE.Review && card.fsrs.due <= now
}

/** until 为可接受的到期上限：取卡口径一律传 now；计数口径（remainingCount/deckCounts）传当日末 */
export function isReviewDue(card: Card, until: number): boolean {
  return !card.deletedAt && !!card.fsrs && card.fsrs.state === FSRS_STATE.Review && card.fsrs.due <= until
}

/**
 * 取下一张卡：Learning/Relearning 到点 → Review 此刻到期 → New；都没有就返回 null。
 * 口径只认**此刻到点**（用户 2026-09-12 定：只管到期，不管当日不当日）：今天晚些时候才到点的复习卡
 * 一律不提前出——它们的到期时刻还在未来，提前放出来会让用户在「到期列已清零」之后刷到的仍是
 * 学过的卡。学习中的回炉卡未到点同样不阻塞新卡（Anki 同款行为），到点后正常插回优先位。
 */
export function pickNext(cards: Card[], now: number): Card | null {
  let best: { rank: number; key: number; card: Card } | null = null
  for (const c of cards) {
    if (c.deletedAt || c.suspended) continue
    let rank: number
    let key: number
    if (isLearningDue(c, now)) {
      rank = 0
      key = c.fsrs!.due
    } else if (isReviewDue(c, now)) {
      rank = 1
      key = c.fsrs!.due
    } else if (!c.fsrs) {
      rank = 2
      key = c.createdAt
    } else {
      continue
    }
    if (!best || rank < best.rank || (rank === best.rank && key < best.key)) {
      best = { rank, key, card: c }
    }
  }
  return best?.card ?? null
}

/** 队列剩余量：当日末前会出现的所有卡（到期复习/学习 + 新卡）；暂停卡不计 */
export function remainingCount(cards: Card[], endOfToday: number): number {
  let n = 0
  for (const c of cards) {
    if (c.deletedAt || c.suspended) continue
    if (!c.fsrs) {
      n++
    } else if (c.fsrs.due <= endOfToday) {
      n++
    }
  }
  return n
}

/** 首页三列口径（需求 §4.3）；暂停卡不计入 */
export function deckCounts(cards: Card[], endOfToday: number): DeckCounts {
  const counts: DeckCounts = { new: 0, learning: 0, review: 0 }
  for (const c of cards) {
    if (c.deletedAt || c.suspended) continue
    if (!c.fsrs) {
      counts.new++
    } else if (c.fsrs.state === FSRS_STATE.Review) {
      if (c.fsrs.due <= endOfToday) counts.review++
    } else {
      counts.learning++
    }
  }
  return counts
}
