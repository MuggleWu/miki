// 会话事件日志：本会话产生的事件 + seq 分配 + 撤销栈。
//
// 与 StatsLedger 拆出的理由一样：这几样东西各自散落时，三条不变量靠人记——
//   1. events 与 eventBySeq 必须同生同灭（原先靠「appendEvents 里两行挨着写」维持，
//      漏一行就是 undo 找不到目标事件直接抛错）；
//   2. seq 单调递增且不重号（原先 8 处 `seq: ++this.seq` 散在对象字面量里）；
//   3. 撤销栈只收「可撤销」的事件（delete/answer/suspend 要，undo 自身不要）。
// 收进来之后，新加一种事件只需要在这里决定「要不要进撤销栈」。
//
// 注意 events 只装本会话事件：历史事件在启动时流式重放完即丢（需求 §19 L1，见 minevents.spec）。
import type { ReviewEvent } from '../shared/types'

export class SessionLog {
  /** 本会话事件（undo 查找用）；历史事件重放后不驻留 */
  private events: ReviewEvent[] = []
  /** 会话事件按 seq 的索引（与 events 同生同灭）：undo 找目标事件 O(1) */
  private bySeq = new Map<number, ReviewEvent>()
  /** 各卡最近一次 suspend 事件：撤销「评 Again 触发的自动暂停」时要判断它是否还是最后一条。
   * 原先每次 undo 反扫一遍整个 events 数组找，长会话里是 O(会话事件数)。 */
  private lastSuspendByCard = new Map<string, ReviewEvent>()
  /** 会话撤销栈（D2：不跨会话）：只存 seq 与 cardId，事件本体在 bySeq 里 */
  private ops: { seq: number; cardId: string }[] = []
  private counter = 0

  /** 当前事件水位（压实快照、统计缓存键都要用；只读，分配走 nextSeq） */
  get seq(): number {
    return this.counter
  }

  /** 本会话事件数（测试断言「历史事件不驻留」用） */
  get length(): number {
    return this.events.length
  }

  /** 撤销栈深度（热加载会作废它，UI 据此提示用户「丢掉了几步」） */
  get undoableCount(): number {
    return this.ops.length
  }

  /** 清零（启动加载 / 热加载重放前调用）：水位归零，撤销栈作废 */
  reset(): void {
    this.events = []
    this.bySeq = new Map()
    this.lastSuspendByCard = new Map()
    this.ops = []
    this.counter = 0
  }

  /** 分配下一个 seq：事件对象在调用方构造，构造完必须交给 append */
  nextSeq(): number {
    return ++this.counter
  }

  /** 登记一批已落盘的事件（保持与落盘同一批次/顺序） */
  append(evs: ReviewEvent[]): void {
    for (const ev of evs) {
      this.events.push(ev)
      this.bySeq.set(ev.seq, ev)
      if (ev.action === 'suspend') this.lastSuspendByCard.set(ev.cardId, ev)
    }
  }

  /** 取事件（撤销目标） */
  get(seq: number): ReviewEvent | undefined {
    return this.bySeq.get(seq)
  }

  /** 取该卡最近一次 suspend 事件（只认最后一条，手动暂停/解除过的不算） */
  lastSuspend(cardId: string): ReviewEvent | undefined {
    return this.lastSuspendByCard.get(cardId)
  }

  /** 把一批事件登记为可撤销（顺序即撤销顺序） */
  pushUndoable(evs: ReviewEvent[]): void {
    for (const ev of evs) this.ops.push({ seq: ev.seq, cardId: ev.cardId })
  }

  /** 弹出最近一次可撤销操作；没有则返回 null */
  popUndoable(): { seq: number; cardId: string } | null {
    return this.ops.pop() ?? null
  }

  /** 作废指定卡片的撤销项（reset 不可撤销：该卡会话历史一并作废） */
  dropUndoable(cardIds: Iterable<string>): void {
    const ids = new Set(cardIds)
    this.ops = this.ops.filter((op) => !ids.has(op.cardId))
  }
}
