// 卡片库查询：多关键词 AND 过滤 + rotate 排序（需求 B2/B4）+ 行 DTO 组装
import type { Card, CardRow, CardState, QueryParams, SortKey, BrowserColumn } from '../shared/types'
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

/** 关键词命中判定：每个关键词至少命中正面或反面之一（kws 须已小写非空） */
export function matchKeywords(front: string, back: string, kws: string[]): boolean {
  for (const k of kws) {
    if (!front.includes(k) && !back.includes(k)) return false
  }
  return true
}

/**
 * 单趟过滤（B3）：关键词 AND + 状态 + 到期窗口一趟判定，替代多趟 filter 中间数组。
 * lowerOf 由调用方提供小写文本（可接缓存）；无任何条件时返回原数组引用。
 */
export function filterCards(cards: Card[], params: QueryParams, lowerOf: (c: Card) => [string, string]): Card[] {
  const kws = params.keywords.map((k) => k.toLowerCase()).filter((k) => k.length > 0)
  const state = params.state
  const dueAfter = params.dueAfter
  const dueBefore = params.dueBefore
  if (kws.length === 0 && state == null && dueAfter == null && dueBefore == null) return cards
  return cards.filter((c) => {
    if (state != null) {
      if (state === 'suspended') {
        if (!c.suspended) return false
      } else if (c.suspended || displayState(c) !== state) return false
    }
    if (dueAfter != null && (c.fsrs == null || c.fsrs.due < dueAfter)) return false
    if (dueBefore != null && (c.fsrs == null || c.fsrs.due > dueBefore)) return false
    if (kws.length > 0) {
      const [front, back] = lowerOf(c)
      if (!matchKeywords(front, back, kws)) return false
    }
    return true
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

/** 中文排序单例：localeCompare 每次调用都新建 Collator，热路径差一个数量级 */
const zhCollator = new Intl.Collator('zh-Hans-CN')

function cmp(a: Comparable, b: Comparable): number {
  if (a == null && b == null) return 0
  if (a == null) return -1
  if (b == null) return 1
  if (typeof a === 'string' && typeof b === 'string') return zhCollator.compare(a, b)
  return (a as number) - (b as number)
}

/** 多列优先级比较：keys[0] 最优先 */
export function compareByKeys(a: Card, b: Card, keys: SortKey[], deckNameOf: (card: Card) => string): number {
  for (const k of keys) {
    const r = cmp(columnValue(a, deckNameOf(a), k.col), columnValue(b, deckNameOf(b), k.col))
    if (r !== 0) return k.asc ? r : -r
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** 装饰排序（decorate-sort-undecorate）：排序前一趟预取全部排序键，
 * 比较器只比预取值——不再每次比较重复调 columnValue/displayState/localeCompare。
 * keys 为空时跳过排序直接返回原数组引用。 */
export function sortByKeys(list: Card[], keys: SortKey[], deckNameOf: (card: Card) => string): Card[] {
  if (keys.length === 0) return list
  const decorated = list.map((c) => ({ card: c, keys: keys.map((k) => columnValue(c, deckNameOf(c), k.col)) }))
  decorated.sort((x, y) => {
    for (let i = 0; i < keys.length; i++) {
      const r = cmp(x.keys[i], y.keys[i])
      if (r !== 0) return keys[i].asc ? r : -r
    }
    return x.card.id < y.card.id ? -1 : x.card.id > y.card.id ? 1 : 0
  })
  return decorated.map((d) => d.card)
}
