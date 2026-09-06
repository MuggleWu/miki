// 学习队列（需求 §5，D3 不限额）：到期复习优先，其后新卡
import type { Card, DeckCounts } from '../shared/types'
import { FSRS_STATE } from '../shared/types'

export function isLearningDue(card: Card, now: number): boolean {
  return (
    !card.deletedAt &&
    !!card.fsrs &&
    card.fsrs.state !== FSRS_STATE.Review &&
    card.fsrs.due <= now
  )
}

export function isReviewDue(card: Card, now: number): boolean {
  return (
    !card.deletedAt &&
    !!card.fsrs &&
    card.fsrs.state === FSRS_STATE.Review &&
    card.fsrs.due <= now
  )
}

/** 取下一张卡：Learning 到期 → Review 到期 → New（各按 due/created 升序）；暂停卡不进队 */
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
