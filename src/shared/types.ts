// shared: main / renderer / core 共用的类型与 DTO

export type Rating = 1 | 2 | 3 | 4 // Again / Hard / Good / Easy

/** 展示状态（new = 从未答题；learning = FSRS Learning/Relearning；review = FSRS Review） */
export type CardState = 'new' | 'learning' | 'review'

/** FSRS 内部状态（对齐 py-fsrs State 枚举）；new = 从未答题（无 fsrs 态） */
export const FSRS_STATE = { Learning: 1, Review: 2, Relearning: 3 } as const
export type FsrsStateEnum = 1 | 2 | 3

/** 答题前的调度快照（事件真理的自包含单元） */
export interface CardSnapshot {
  state: FsrsStateEnum
  step: number | null
  stability: number | null
  difficulty: number | null
  due: number // ms epoch
  lastReview: number | null
}

/** review-log 事件（调度真理，append-only） */
export interface ReviewEvent {
  seq: number
  t: number // ms epoch
  action: 'answer' | 'delete' | 'undo' | 'reset' | 'suspend'
  cardId: string
  deckId: string
  rating?: Rating
  /** answer: 答题前快照；delete: 删除前调度快照；undo: 恢复到的快照 */
  before?: CardSnapshot | null
  /** answer: 答题后快照 */
  after?: CardSnapshot | null
  /** undo: 指向本会话被撤销事件的 seq */
  targetSeq?: number
  /** undo: 被撤销事件的 action/rating（重放自包含，免回查事件窗口） */
  targetAction?: 'answer' | 'delete' | 'undo' | 'reset' | 'suspend'
  targetRating?: Rating
  /** suspend: 目标暂停状态（true 暂停 / false 解除） */
  suspended?: boolean
  durationMs?: number
}

/** cards/<deck-id>.ndjson 每行（内容真理，仅内容字段） */
export interface CardContent {
  id: string
  front: string
  back: string
  createdAt: number
  updatedAt: number
  deletedAt: number | null
  /** leech：重来次数达到阈值时自动暂停；暂停卡不进调度 due */
  suspended: boolean
}

/** 内存中的完整卡（重放结果）；reps/lapses 由事件重放统计，不入文件 */
export interface Card extends CardContent {
  deckId: string
  fsrs: CardSnapshot | null // null = new
  reps: number
  lapses: number
  /** 调度索引决胜序（= Map 插入序），非持久内存字段，落盘/重放不携带 */
  tie?: number
  /** 本卡调度状态已反映到的事件水位（seq），非持久内存字段；快照行以 __mikiSeq 落盘 */
  seqApplied?: number
}

export interface Deck {
  id: string
  name: string
  order: number
  createdAt: number
  deletedAt: number | null
}

// ---------- DTO ----------

/** 统计页状态分布（computeStats 填充） */
export interface DeckCounts {
  new: number
  learning: number
  review: number
}

/** 首页牌组表三列口径：总数=牌组内未删卡（含暂停）；未学习=新卡；到期=此刻已到期、点进去立刻能刷的学习/复习卡（不含新卡、不含未到期、不含暂停） */
export interface DeckTableCounts {
  total: number
  new: number
  due: number
}

export interface DeckInfo extends Deck {
  counts: DeckTableCounts
}

export interface StudyPayload {
  card: Card | null
  remaining: number
  todayCount: number
}

export interface AnswerResult extends StudyPayload {
  answeredCardId: string
}

export interface UndoResult extends StudyPayload {
  restoredCardId: string | null
}

export type BrowserColumn =
  | 'front'
  | 'deckName'
  | 'state'
  | 'due'
  | 'dueAbs'
  | 'interval'
  | 'stability'
  | 'difficulty'
  | 'reps'
  | 'lapses'
  | 'createdAt'
  | 'updatedAt'

export interface SortKey {
  col: BrowserColumn
  asc: boolean
}

export interface CardRow {
  id: string
  deckId: string
  deckName: string
  front: string
  back: string
  state: CardState
  due: number | null
  intervalDays: number | null
  stability: number | null
  difficulty: number | null
  reps: number
  lapses: number
  suspended: boolean
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

/** 查询状态过滤：'suspended' 按暂停标记，其余按调度状态 */
export type QueryState = CardState | 'suspended'

export interface QueryParams {
  deckId: string | null // null = 全部牌组
  keywords: string[]
  sort: SortKey[]
  limit?: number
  offset?: number
  state?: QueryState | null
  /** 到期时间窗（ms epoch），无调度进度的卡在指定窗口时被排除 */
  dueBefore?: number | null
  dueAfter?: number | null
}

export interface QueryResult {
  rows: CardRow[]
  total: number
}

export interface StatsParams {
  deckId: string | null
  range: 'year' | 'all'
}

export interface StatsPayload {
  /** 预测：等宽时间桶（38 根），label 为桶起点，range 为桶起止文本（tooltip 用） */
  forecast: { label: string; count: number; range: string }[]
  heatmap: { date: string; count: number }[] // yyyy-MM-dd
  reviews: { label: string; total: number; again: number }[]
  stateCounts: DeckCounts
  intervals: { bucket: string; count: number }[]
}

export type Theme = 'light' | 'dark'

/** 主窗口状态（跨启动恢复尺寸/位置/最大化；存工作区 config.json） */
export interface WindowState {
  /** 普通态（非最大化）的坐标；null = 首次启动交给系统摆放 */
  x: number | null
  y: number | null
  width: number
  height: number
  maximized: boolean
}

/** 刷卡界面的字体设置（fontFamily 空 = 跟随系统默认） */
export interface StudyFont {
  fontFamily: string
  fontSize: number
}

/** 添加/编辑卡片弹窗的状态（主窗口 store 与弹窗子窗口共用） */
export interface DialogState {
  mode: 'add' | 'edit'
  deckId: string | null
  /** edit 模式的卡 ID */
  cardId: string | null
}

export interface MikiConfig {
  workspacePath: string
  theme: Theme
  desiredRetention: number
  parameters: number[]
  learningStepsSec: number[]
  relearningStepsSec: number[]
  maximumInterval: number
  enableFuzzing: boolean
  /** leech 阈值：累计「重来」次数达到该值的卡自动暂停（0 = 关闭） */
  leechThreshold: number
  /** 本机 HTTP API（面向人与 AI 的程序化接口；token 空 = 首次启动自动生成） */
  api: { enabled: boolean; port: number; token: string }
  study: StudyFont
  browser: {
    columns: BrowserColumn[]
    sort: SortKey[]
    /** 卡片库离开时的选中态：左树牌组 + 内容区主选中卡（跨启动恢复） */
    selectedDeckId?: string | null
    selectedCardId?: string | null
  }
  /** 主窗口尺寸/位置/最大化（resize/move 防抖落盘，下次启动恢复） */
  window: WindowState
  /** 添加/编辑卡片弹窗子窗口的位置/尺寸（可选：旧 config 无此字段，首次开窗居中于主窗口） */
  cardDialogWindow?: { x: number | null; y: number | null; width: number; height: number }
}

export const DEFAULT_CONFIG: Omit<MikiConfig, 'workspacePath'> = {
  theme: 'light',
  desiredRetention: 0.9,
  parameters: [
    0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483,
    0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542
  ],
  learningStepsSec: [60, 600],
  relearningStepsSec: [600],
  maximumInterval: 36500,
  enableFuzzing: true,
  leechThreshold: 8,
  api: { enabled: true, port: 8727, token: '' },
  study: { fontFamily: '', fontSize: 16 },
  browser: {
    columns: ['front', 'deckName', 'state', 'due', 'updatedAt'],
    sort: [{ col: 'updatedAt', asc: false }]
  },
  window: { x: null, y: null, width: 1280, height: 840, maximized: false }
}
