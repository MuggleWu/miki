// 事件重放：review-log（调度真理）→ 内存卡片状态（需求 §4.4 / 技术栈 §4 / §19 L1）
// applyEvent 是单事件应用的唯一语义源：replayCard（分组重放，测试用）与
// WorkspaceService 的流式重放（历史事件不驻留内存）都走它，避免两套语义漂移。
import type { Card, CardContent, CardSnapshot, Rating, ReviewEvent } from '../shared/types'

function cloneSnap(s: CardSnapshot | null | undefined): CardSnapshot | null {
  return s ? { ...s } : null
}

/** undo 抵消目标的描述（action 决定是否回退 reps/lapses） */
export interface UndoTargetInfo {
  action: ReviewEvent['action']
  rating?: Rating
}

/** 流式应用一个事件到卡（假设事件按全局 seq 升序到达） */
export function applyEvent(card: Card, ev: ReviewEvent, undoTarget?: UndoTargetInfo | null): void {
  if (ev.action === 'answer') {
    card.fsrs = cloneSnap(ev.after ?? null)
    card.reps++
    if (ev.rating === 1) card.lapses++
  } else if (ev.action === 'delete') {
    card.deletedAt = ev.t
  } else if (ev.action === 'reset') {
    // 重置进度：调度状态与答题统计全部清零、解除暂停，卡片变回新卡（不可撤销）
    card.fsrs = null
    card.reps = 0
    card.lapses = 0
    card.suspended = false
  } else if (ev.action === 'suspend') {
    card.suspended = ev.suspended ?? true
  } else {
    // undo：恢复 target 事件之前的调度状态；内容删除状态一并恢复。
    // 优先用事件自带的 targetAction/targetRating（新版自包含），
    // 旧事件缺失时由调用方传入事件窗口里的 target 信息。
    const eff = undoTarget ?? (ev.targetAction ? { action: ev.targetAction, rating: ev.targetRating } : null)
    if (eff?.action === 'answer') {
      card.reps = Math.max(0, card.reps - 1)
      if (eff.rating === 1) card.lapses = Math.max(0, card.lapses - 1)
    }
    card.fsrs = cloneSnap(ev.before ?? null)
    card.deletedAt = null
  }
}

/**
 * 从内容 + 事件流重放出一卡。events 必须已按全局 seq 升序。
 * reps/lapses 按事件流统计（answer +1 / Again +1），undo 抵消目标事件。
 * 调度状态以 answer.after / undo.before 快照为准（参数变化不影响历史重放）。
 */
export function replayCard(
  content: CardContent,
  deckId: string,
  events: ReviewEvent[]
): Card {
  const card: Card = { ...content, deckId, fsrs: null, reps: 0, lapses: 0 }
  const bySeq = new Map<number, ReviewEvent>()

  for (const ev of events) {
    if (ev.action === 'answer') bySeq.set(ev.seq, ev)
    const target =
      ev.action === 'undo' && ev.targetSeq != null
        ? bySeq.get(ev.targetSeq) ?? null
        : null
    applyEvent(card, ev, target)
  }
  return card
}
