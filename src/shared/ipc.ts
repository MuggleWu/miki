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
  saveTheme: 'miki:save-theme'
} as const
