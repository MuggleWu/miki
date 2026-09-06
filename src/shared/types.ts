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
  action: 'answer' | 'delete' | 'undo' | 'reset'
  cardId: string
  deckId: string
  rating?: Rating
  /** answer: 答题前快照；delete: 删除前调度快照；undo: 恢复到的快照 */
  before?: CardSnapshot | null
  /** answer: 答题后快照 */
  after?: CardSnapshot | null
  /** undo: 指向本会话被撤销事件的 seq */
  targetSeq?: number
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
}

export interface Deck {
  id: string
  name: string
  order: number
  createdAt: number
  deletedAt: number | null
}

// ---------- DTO ----------

export interface DeckCounts {
  new: number
  learning: number
  review: number
}

export interface DeckInfo extends Deck {
  counts: DeckCounts
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

export interface QueryParams {
  deckId: string | null // null = 全部牌组
  keywords: string[]
  sort: SortKey[]
  limit?: number
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
  forecast: { label: string; count: number }[]
  heatmap: { date: string; count: number }[] // yyyy-MM-dd
  reviews: { label: string; total: number; again: number }[]
  stateCounts: DeckCounts
  intervals: { bucket: string; count: number }[]
}

export type Theme = 'light' | 'dark'

/** 刷卡界面的字体设置（fontFamily 空 = 跟随系统默认） */
export interface StudyFont {
  fontFamily: string
  fontSize: number
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
  study: StudyFont
  browser: {
    columns: BrowserColumn[]
    sort: SortKey[]
  }
}

export const DEFAULT_CONFIG: Omit<MikiConfig, 'workspacePath'> = {
  theme: 'light',
  desiredRetention: 0.9,
  parameters: [
    0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722,
    0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425,
    0.0912, 0.0658, 0.1542
  ],
  learningStepsSec: [60, 600],
  relearningStepsSec: [600],
  maximumInterval: 36500,
  enableFuzzing: true,
  leechThreshold: 8,
  study: { fontFamily: '', fontSize: 16 },
  browser: {
    columns: ['front', 'deckName', 'state', 'due', 'updatedAt'],
    sort: [{ col: 'updatedAt', asc: false }]
  }
}
