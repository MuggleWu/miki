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
import type { WorkspaceStatus } from './workspace'

/** 深合并的配置补丁：study/browser 允许只传部分字段（如选中态、只改字号） */
export type MikiConfigPatch = Partial<Omit<MikiConfig, 'browser' | 'study'>> & {
  browser?: Partial<MikiConfig['browser']>
  study?: Partial<MikiConfig['study']>
}

export interface MikiApi {
  /** 全量加载（decks + counts + today + 累计 + config） */
  loadWorkspace(): Promise<{ decks: DeckInfo[]; todayCount: number; totalCount: number; config: MikiConfig }>
  addDeck(name: string): Promise<DeckInfo[]>
  renameDeck(id: string, name: string): Promise<DeckInfo[]>
  deleteDeck(id: string): Promise<DeckInfo[]>
  getStudy(deckId: string): Promise<StudyPayload>
  answer(cardId: string, rating: Rating, durationMs?: number): Promise<StudyPayload & { answeredCardId: string }>
  undo(): Promise<UndoResult>
  addCard(deckId: string, front: string, back: string): Promise<Card>
  updateCard(cardId: string, patch: { front?: string; back?: string }): Promise<Card | null>
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
  updateCards(items: { cardId: string; front?: string; back?: string }[]): Promise<{ updated: number; missing: number }>
  /** 批量软删（可撤销），返回删除数与不存在的 ID 数 */
  deleteCards(cardIds: string[]): Promise<{ deleted: number; missing: number }>
  /** 按 ID 批量取卡片完整内容（保持入参顺序，跳过不存在的 ID） */
  getCards(cardIds: string[]): Promise<Card[]>
  /** 四档评级各自的下次到期预览（ms epoch；不落盘） */
  previewIntervals(cardId: string): Promise<number[]>
  /** 订阅工作区外部变更（git pull / 他机写入）后主进程热加载完成事件；返回退订函数 */
  onWorkspaceChanged(cb: () => void): () => void
  /** 请求打开卡片添加/编辑弹窗子窗口（已开着则聚焦并切换到新载荷） */
  openCardDialog(payload: unknown): Promise<void>
  /** 请求关闭卡片弹窗子窗口（未开着时 no-op） */
  closeCardDialog(): Promise<void>
  /** 弹窗子窗口提交后通知：主进程转发给主窗口刷新数据（kind=add/edit） */
  notifyCardsChanged(kind: 'add' | 'edit'): Promise<void>
  /** 订阅弹窗子窗口推送的载荷（主进程在弹窗窗口加载完成/重复打开时下发） */
  onCardDialogPayload(cb: (payload: unknown) => void): () => void
  /** 订阅卡片数据变更（弹窗子窗口提交后触发；主窗口收到后刷新牌组计数与当前视图） */
  onCardsChanged(cb: (p: { kind: 'add' | 'edit' }) => void): () => void
  /** 订阅弹窗开关状态（主窗口据此同步 store.dialog：快捷键屏蔽 + Esc 关弹窗） */
  onCardDialogVisibility(cb: (visible: boolean) => void): () => void
  /** 工作区状态：是否需要首次引导 + 当前路径 + 已记住的多工作区列表 */
  workspaceStatus(): Promise<WorkspaceStatus>
  /** 打开系统文件夹选择对话框（openDirectory + createDirectory），返回所选路径或 null */
  workspaceChooseFolder(): Promise<string | null>
  /** 首次引导确认：创建/复用该文件夹并设为当前工作区（主进程随后完成初始化） */
  workspaceConfirm(path: string): Promise<{ ok: boolean; error?: string; status: WorkspaceStatus }>
  /** 登记工作区：文件夹不存在则创建；只进列表不切换 */
  workspaceAdd(path: string): Promise<{ ok: boolean; error?: string; status: WorkspaceStatus }>
  /** 切换工作区：写指针后应用自动重启载入新档案 */
  workspaceSwitch(path: string): Promise<{ ok: boolean; error?: string }>
  /** 从列表移除工作区（当前生效的不可移除；不删除文件夹内任何数据） */
  workspaceRemove(path: string): Promise<WorkspaceStatus>
  /** 在系统文件管理器中显示该工作区文件夹 */
  workspaceReveal(path: string): Promise<void>
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
  previewIntervals: 'miki:preview-intervals',
  /** main → renderer 事件：工作区外部变更已热加载，UI 应刷新当前视图 */
  workspaceChanged: 'miki:workspace-changed',
  /** renderer（主窗口/弹窗窗口）→ main：打开/关闭卡片弹窗子窗口 */
  openCardDialog: 'miki:open-card-dialog',
  closeCardDialog: 'miki:close-card-dialog',
  /** renderer（弹窗窗口）→ main：提交后通知，main 转发主窗口 */
  notifyCardsChanged: 'miki:notify-cards-changed',
  /** main → renderer：弹窗载荷下发（弹窗窗口）/开关状态（主窗口）/卡片数据变更（主窗口） */
  cardDialogPayload: 'miki:card-dialog-payload',
  cardDialogVisibility: 'miki:card-dialog-visibility',
  cardsChanged: 'miki:cards-changed',
  /** renderer → main：多工作区（多用户档案）管理 */
  workspaceStatus: 'miki:workspace-status',
  workspaceChooseFolder: 'miki:workspace-choose-folder',
  workspaceConfirm: 'miki:workspace-confirm',
  workspaceAdd: 'miki:workspace-add',
  workspaceSwitch: 'miki:workspace-switch',
  workspaceRemove: 'miki:workspace-remove',
  workspaceReveal: 'miki:workspace-reveal'
} as const
