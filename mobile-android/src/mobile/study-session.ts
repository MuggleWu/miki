// 学习会话控制器：把「出卡 → 显示答案 → 评级 → 下一张 → 撤销」这套状态机从 React 里拿出来。
//
// 为什么单独一层：这是移动端唯一高频操作路径，步骤之间还有耗时口径（问题上屏到按评级的
// 墙钟差、要按 MAX_ANSWER_MS 封顶）和「撤销后回到哪张卡」这类容易写错的细节。放在组件里
// 就只能靠渲染测试来验；抽出来后可以直接跑用例，组件退化成一层薄视图。
import { clampAnswerMs, fmtDuePreview } from '@shared/format'
import type { Card, Rating, StudyPayload } from '@shared/types'
import type { MobileWorkspace } from './workspace'

export interface StudyState {
  /** 当前要学的卡；null = 这个牌组今天没有待学卡 */
  card: Card | null
  /** 是否已显示答案（未显示时评级按钮不出现在屏幕上） */
  revealed: boolean
  /** 该牌组今天剩余待学数（含当前这张） */
  remaining: number
  /** 今日已答题数（全牌组） */
  todayCount: number
  /** 四档评级各自的下次到期毫秒（未显示答案时为 null） */
  preview: { rating: Rating; due: number; label: string }[] | null
  /** 本会话还能撤销几步 */
  undoable: number
  /** 上一次操作的结果提示（UI 用来做一次性提示条） */
  flash: string | null
}

const RATINGS: Rating[] = [1, 2, 3, 4]

export class StudySession {
  private state: StudyState
  /** 当前这张卡上屏的时刻（算答题耗时用；显示答案不重置它——耗时口径是"看到题到评级"） */
  private shownAt = 0

  constructor(
    private readonly ws: MobileWorkspace,
    readonly deckId: string
  ) {
    this.state = this.blank()
  }

  private blank(): StudyState {
    return { card: null, revealed: false, remaining: 0, todayCount: 0, preview: null, undoable: 0, flash: null }
  }

  get(): StudyState {
    return this.state
  }

  /** 进入学习页 / 换牌组：取下一张卡 */
  start(now = Date.now()): StudyState {
    return this.load(now)
  }

  private load(now: number, flash: string | null = null): StudyState {
    const payload: StudyPayload = this.ws.getStudy(this.deckId)
    this.shownAt = now
    this.state = {
      card: payload.card,
      revealed: false,
      remaining: payload.remaining,
      todayCount: payload.todayCount,
      preview: null,
      undoable: this.ws.undoableCount(),
      flash
    }
    return this.state
  }

  /**
   * 工作区在页面之外被改过（同步拉取 / 回到前台重载）后刷新一次。
   *
   * 页面上的 `state.card` 是重载**之前**那个 Card 对象：重载会整体换新卡对象，手里这份
   * 就成了脱钩的旧快照——卡面还是旧文案、可撤销数还是旧值。这里按 id 重新取一次当前这张，
   * 但**不换卡**：正在看的这张不动（答题被中途抽走比看到旧文案糟得多）。
   * 当前这张已经不在（被删/暂停/不再到期）了才交给 load() 重挑一张。
   */
  refresh(now = Date.now()): StudyState {
    const cur = this.state.card
    if (!cur) return this.load(now)
    const live = this.ws.getCard(cur.id)
    if (!live || live.deletedAt || live.suspended) return this.load(now)
    this.state = {
      ...this.state,
      card: live,
      remaining: this.ws.getStudy(this.deckId).remaining,
      todayCount: this.ws.todayCount(),
      undoable: this.ws.undoableCount()
    }
    return this.state
  }

  /** 点按卡面：显示答案并算出四档的下次间隔预览 */
  reveal(now = Date.now()): StudyState {
    const card = this.state.card
    if (!card || this.state.revealed) return this.state
    const dues = this.ws.previewIntervals(card.id)
    this.state = {
      ...this.state,
      revealed: true,
      preview: RATINGS.map((rating, i) => ({ rating, due: dues[i], label: fmtDuePreview(dues[i], now) })),
      flash: null
    }
    return this.state
  }

  /** 评级：落盘（review-log 追加）后立刻出下一张卡 */
  async rate(rating: Rating, now = Date.now()): Promise<StudyState> {
    const card = this.state.card
    if (!card || !this.state.revealed) return this.state
    const durationMs = clampAnswerMs(now - this.shownAt)
    await this.ws.answer(card.id, rating, durationMs)
    return this.load(now)
  }

  /** 撤销上一笔可撤销操作（答题或删除），并把该卡重新摆到屏幕中央 */
  async undo(now = Date.now()): Promise<StudyState> {
    const res = await this.ws.undo()
    if (!res.restoredCardId || !res.card) {
      this.state = { ...this.state, undoable: this.ws.undoableCount(), flash: '没有可撤销的操作' }
      return this.state
    }
    this.shownAt = now
    this.state = {
      card: res.card,
      revealed: false,
      remaining: res.remaining,
      todayCount: res.todayCount,
      preview: null,
      undoable: this.ws.undoableCount(),
      flash: '已撤销'
    }
    return this.state
  }

  /** 当前卡被删除/编辑后，用最新内存态刷新屏幕上的这张卡 */
  refreshCard(): StudyState {
    const id = this.state.card?.id
    if (!id) return this.state
    const fresh = this.ws.getCard(id)
    if (fresh && fresh.deletedAt) return this.load(Date.now(), '卡片已删除')
    if (fresh && fresh !== this.state.card) {
      // 编辑后要重算预览（内容变了，但调度没变，预览本身不变——这里只更新正文）
      return (this.state = { ...this.state, card: fresh })
    }
    return this.state
  }
}
