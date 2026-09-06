// 卡片库查询：多关键词 AND 过滤 + rotate 排序（需求 B2/B4）+ 行 DTO 组装
import type { Card, CardRow, CardState, SortKey, BrowserColumn } from '../shared/types'
import { FSRS_STATE } from '../shared/types'

export function displayState(card: Card): CardState {
  if (!card.fsrs) return 'new'
  if (card.fsrs.state === FSRS_STATE.Review) return 'review'
  return 'learning'
}

export function intervalDays(card: Card): number | null {
  const f = card.fsrs
  if (!f || f.state === FSRS_STATE.Learning || f.state === FSRS_STATE.Relearning) return null
  if (f.lastReview == null) return null
  return Math.max(1, Math.round((f.due - f.lastReview) / 86_400_000))
}

export function toRow(card: Card, deckName: string): CardRow {
  return {
    id: card.id,
    deckId: card.deckId,
    deckName,
    front: card.front,
    back: card.back,
    state: displayState(card),
    due: card.fsrs?.due ?? null,
    intervalDays: intervalDays(card),
    stability: card.fsrs?.stability ?? null,
    difficulty: card.fsrs?.difficulty ?? null,
    reps: card.reps,
    lapses: card.lapses,
    suspended: card.suspended ?? false,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    deletedAt: card.deletedAt
  }
}

/** 多关键词 AND、大小写不敏感，作用于正面/反面 */
export function filterByKeywords(cards: Card[], keywords: string[]): Card[] {
  const kws = keywords.map((k) => k.toLowerCase()).filter((k) => k.length > 0)
  if (kws.length === 0) return cards
  return cards.filter((c) => {
    const front = c.front.toLowerCase()
    const back = c.back.toLowerCase()
    return kws.every((k) => front.includes(k) || back.includes(k))
  })
}

/**
 * B4 rotate：点击列提为第一优先级，其余保序后移；
 * 若点击列已是首位，则翻转该列升降序。
 */
export function rotateSort(current: SortKey[], clicked: BrowserColumn): SortKey[] {
  const first = current[0]
  if (first && first.col === clicked) {
    return [{ ...first, asc: !first.asc }, ...current.slice(1)]
  }
  const rest = current.filter((k) => k.col !== clicked)
  return [{ col: clicked, asc: true }, ...rest]
}

type Comparable = string | number | null

function columnValue(card: Card, deckName: string, col: BrowserColumn): Comparable {
  switch (col) {
    case 'front':
      return card.front
    case 'deckName':
      return deckName
    case 'state':
      return displayState(card)
    case 'due':
      return card.fsrs?.due ?? null
    case 'dueAbs':
      return card.fsrs?.due ?? null
    case 'interval':
      return intervalDays(card)
    case 'stability':
      return card.fsrs?.stability ?? null
    case 'difficulty':
      return card.fsrs?.difficulty ?? null
    case 'reps':
      return card.reps
    case 'lapses':
      return card.lapses
    case 'createdAt':
      return card.createdAt
    case 'updatedAt':
      return card.updatedAt
  }
}

function cmp(a: Comparable, b: Comparable): number {
  if (a == null && b == null) return 0
  if (a == null) return -1
  if (b == null) return 1
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b, 'zh-Hans-CN')
  return (a as number) - (b as number)
}

/** 多列优先级比较：keys[0] 最优先 */
export function compareByKeys(
  a: Card,
  b: Card,
  keys: SortKey[],
  deckNameOf: (card: Card) => string
): number {
  for (const k of keys) {
    const r = cmp(columnValue(a, deckNameOf(a), k.col), columnValue(b, deckNameOf(b), k.col))
    if (r !== 0) return k.asc ? r : -r
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
