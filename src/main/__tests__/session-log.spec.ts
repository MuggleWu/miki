// SessionLog 的不变量：events 与 seq 索引同生同灭、撤销栈只收该收的、每卡最近 suspend 索引。
// 这些原先靠 workspace.ts 里「两行挨着写」维持，现在有了独立单元可以正面钉住。
import { describe, expect, it } from 'vitest'
import { SessionLog } from '../../shared/session-log'
import type { ReviewEvent } from '../../shared/types'

const evOf = (seq: number, over: Partial<ReviewEvent> = {}): ReviewEvent => ({
  seq,
  t: 1_700_000_000_000 + seq,
  action: 'answer',
  cardId: 'c1',
  deckId: 'd1',
  rating: 3,
  ...over
})

describe('SessionLog：seq 与事件登记', () => {
  it('nextSeq 单调递增且不重号', () => {
    const log = new SessionLog()
    expect([log.nextSeq(), log.nextSeq(), log.nextSeq()]).toEqual([1, 2, 3])
    expect(log.seq).toBe(3)
  })

  it('append 后按 seq 可取回（撤销靠这条）', () => {
    const log = new SessionLog()
    const a = evOf(log.nextSeq())
    const b = evOf(log.nextSeq(), { cardId: 'c2' })
    log.append([a, b])
    expect(log.get(a.seq)).toBe(a)
    expect(log.get(b.seq)).toBe(b)
    expect(log.length).toBe(2)
  })

  it('取不存在的 seq → undefined（不抛错）', () => {
    expect(new SessionLog().get(999)).toBeUndefined()
  })

  it('reset 清零水位与索引（重放/热加载路径）', () => {
    const log = new SessionLog()
    const ev = evOf(log.nextSeq())
    log.append([ev])
    log.pushUndoable([ev])
    log.reset()
    expect(log.seq).toBe(0)
    expect(log.length).toBe(0)
    expect(log.get(ev.seq)).toBeUndefined()
    expect(log.popUndoable()).toBeNull()
    // 重置后 seq 从 1 重新开始（与「重放即新会话」语义一致）
    expect(log.nextSeq()).toBe(1)
  })
})

describe('SessionLog：撤销栈', () => {
  it('后进先出，且只返回登记过的', () => {
    const log = new SessionLog()
    const a = evOf(log.nextSeq())
    const b = evOf(log.nextSeq(), { cardId: 'c2' })
    log.pushUndoable([a])
    log.pushUndoable([b])
    expect(log.popUndoable()).toEqual({ seq: b.seq, cardId: 'c2' })
    expect(log.popUndoable()).toEqual({ seq: a.seq, cardId: 'c1' })
    expect(log.popUndoable()).toBeNull()
  })

  it('一批多卡：同批按入参顺序登记（撤销时后登记的先生效）', () => {
    const log = new SessionLog()
    const evs = [evOf(log.nextSeq(), { cardId: 'c1' }), evOf(log.nextSeq(), { cardId: 'c2' })]
    log.pushUndoable(evs)
    expect(log.popUndoable()?.cardId).toBe('c2')
    expect(log.popUndoable()?.cardId).toBe('c1')
  })

  it('dropUndoable 作废指定卡片（reset 不可撤销），其余保留', () => {
    const log = new SessionLog()
    const a = evOf(log.nextSeq(), { cardId: 'c1' })
    const b = evOf(log.nextSeq(), { cardId: 'c2' })
    const c = evOf(log.nextSeq(), { cardId: 'c3' })
    log.pushUndoable([a, b, c])
    log.dropUndoable(['c2'])
    expect(log.popUndoable()?.cardId).toBe('c3')
    expect(log.popUndoable()?.cardId).toBe('c1')
    expect(log.popUndoable()).toBeNull()
  })

  it('dropUndoable 传空集合 / 不存在的 id 不影响栈', () => {
    const log = new SessionLog()
    log.pushUndoable([evOf(log.nextSeq(), { cardId: 'c1' })])
    log.dropUndoable([])
    log.dropUndoable(['nope'])
    expect(log.popUndoable()?.cardId).toBe('c1')
  })
})

describe('SessionLog：每卡最近 suspend 索引', () => {
  const suspend = (log: SessionLog, cardId: string, suspended: boolean): ReviewEvent =>
    evOf(log.nextSeq(), { action: 'suspend', cardId, suspended })

  it('同一张卡多次 suspend 时，只认最后一次', () => {
    const log = new SessionLog()
    const s1 = suspend(log, 'c1', true)
    const s2 = suspend(log, 'c1', true)
    log.append([s1, s2])
    expect(log.lastSuspend('c1')).toBe(s2)
    expect(log.lastSuspend('c1')).not.toBe(s1)
  })

  it('各卡的 suspend 互不干扰', () => {
    const log = new SessionLog()
    const a = suspend(log, 'c1', true)
    const b = suspend(log, 'c2', true)
    log.append([a, b])
    expect(log.lastSuspend('c1')).toBe(a)
    expect(log.lastSuspend('c2')).toBe(b)
  })

  it('非 suspend 事件不进入该索引（answer 不会顶掉 suspend）', () => {
    const log = new SessionLog()
    const s = suspend(log, 'c1', true)
    const ans = evOf(log.nextSeq(), { cardId: 'c1', action: 'answer' })
    log.append([s, ans])
    expect(log.lastSuspend('c1')).toBe(s)
  })

  it('未记录过的卡 → undefined（撤销时它就不是「最后一次暂停」）', () => {
    expect(new SessionLog().lastSuspend('c1')).toBeUndefined()
  })

  it('reset 后索引清空（避免跨重放误判自动暂停）', () => {
    const log = new SessionLog()
    log.append([suspend(log, 'c1', true)])
    expect(log.lastSuspend('c1')).toBeDefined()
    log.reset()
    expect(log.lastSuspend('c1')).toBeUndefined()
  })
})
