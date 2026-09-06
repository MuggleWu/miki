// IPC 通道与调用签名（main / preload / renderer 共用）
import type {
  Card,
  Deck,
  DeckInfo,
  MikiConfig,
  QueryParams,
  QueryResult,
  Rating,
  StatsParams,
  StatsPayload,
  StudyPayload,
  UndoResult
} from './types'

/** 深合并的配置补丁：browser 允许只传部分字段（如选中态） */
export type MikiConfigPatch = Partial<Omit<MikiConfig, 'browser'>> & {
  browser?: Partial<MikiConfig['browser']>
}

export interface MikiApi {
  /** 全量加载（decks + counts + today + config） */
  loadWorkspace(): Promise<{ decks: DeckInfo[]; todayCount: number; config: MikiConfig }>
  addDeck(name: string): Promise<DeckInfo[]>
  renameDeck(id: string, name: string): Promise<DeckInfo[]>
  deleteDeck(id: string): Promise<DeckInfo[]>
  getStudy(deckId: string): Promise<StudyPayload>
  answer(cardId: string, rating: Rating, durationMs?: number): Promise<StudyPayload & { answeredCardId: string }>
  undo(): Promise<UndoResult>
  addCard(deckId: string, front: string, back: string): Promise<Card>
  updateCard(cardId: string, front: string, back: string): Promise<Card | null>
  getCard(cardId: string): Promise<Card | null>
  deleteCard(cardId: string): Promise<void>
  queryCards(params: QueryParams): Promise<QueryResult>
  getStats(params: StatsParams): Promise<StatsPayload>
  saveBrowserConfig(columns: string[], sort: unknown[]): Promise<void>
  saveTheme(theme: 'light' | 'dark'): Promise<void>
  /** 设置页/卡片库：深合并保存配置（字体 / leech / browser 选中态等），返回新 config */
  saveConfig(patch: MikiConfigPatch): Promise<MikiConfig>
  setCardSuspended(cardId: string, suspended: boolean): Promise<Card | null>
  /** 批量移动卡片到目标牌组（保留调度进度），返回移动数 */
  moveCards(cardIds: string[], deckId: string): Promise<number>
  /** 批量重置进度：变回新卡（不可撤销），返回处理数 */
  resetProgress(cardIds: string[]): Promise<number>
  /** 批量新增卡片（同批共用时间戳、一次落盘），返回创建的卡（含 id） */
  addCards(deckId: string, items: { front: string; back: string }[]): Promise<Card[]>
  /** 批量更新正面/反面，返回更新数与不存在的 ID 数 */
  updateCards(items: { cardId: string; front: string; back: string }[]): Promise<{ updated: number; missing: number }>
  /** 批量软删（可撤销），返回删除数与不存在的 ID 数 */
  deleteCards(cardIds: string[]): Promise<{ deleted: number; missing: number }>
  /** 按 ID 批量取卡片完整内容（保持入参顺序，跳过不存在的 ID） */
  getCards(cardIds: string[]): Promise<Card[]>
  /** 四档评级各自的下次到期预览（ms epoch；不落盘） */
  previewIntervals(cardId: string): Promise<number[]>
}

export const IPC = {
  loadWorkspace: 'miki:load-workspace',
  addDeck: 'miki:add-deck',
  renameDeck: 'miki:rename-deck',
  deleteDeck: 'miki:delete-deck',
  getStudy: 'miki:get-study',
  answer: 'miki:answer',
  undo: 'miki:undo',
  addCard: 'miki:add-card',
  updateCard: 'miki:update-card',
  getCard: 'miki:get-card',
  deleteCard: 'miki:delete-card',
  queryCards: 'miki:query-cards',
  getStats: 'miki:get-stats',
  saveBrowserConfig: 'miki:save-browser-config',
  saveTheme: 'miki:save-theme',
  saveConfig: 'miki:save-config',
  setCardSuspended: 'miki:set-card-suspended',
  moveCards: 'miki:move-cards',
  resetProgress: 'miki:reset-progress',
  addCards: 'miki:add-cards',
  updateCards: 'miki:update-cards',
  deleteCards: 'miki:delete-cards',
  getCards: 'miki:get-cards',
  previewIntervals: 'miki:preview-intervals'
} as const
