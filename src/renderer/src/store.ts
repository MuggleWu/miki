// 全局状态：tab 路由、牌组列表、选中态、跨页焦点与界面布局
import { create } from 'zustand'
import { dialogToPayload } from '../../shared/card-dialog'
import type { BrowserColumn, DeckInfo, MikiConfig } from '../../shared/types'

export type Tab = 'home' | 'study' | 'browser' | 'stats' | 'settings'

/** 添加/编辑卡片弹窗状态（结构定义在 shared，主窗口与弹窗子窗口共用） */
export type DialogState = import('../../shared/types').DialogState

interface AppStore {
  tab: Tab
  decks: DeckInfo[]
  todayCount: number
  /** 历史累计净答题数（loadWorkspace 随牌组一起刷新） */
  totalCount: number
  config: MikiConfig | null
  selectedDeckId: string | null
  studyDeckId: string | null
  /** 学习页当前卡（供 B 快捷键定位卡片库） */
  studyCurrentCardId: string | null
  browserDeckId: string | null
  browserFocusCardId: string | null
  /** 卡片库界面态：切走再切回保持原样（列配置/排序在 config 里持久化） */
  browserKeywords: string
  browserSelectedId: string | null
  /** 首次 loadWorkspace 后从 config 恢复离开时的选中态（只执行一次） */
  browserRestored: boolean
  /** 卡片库布局：左栏宽 / 表格宽（px），跨页保持 */
  browserSideWidth: number
  browserGridWidth: number | null
  /** 卡片库列宽（px，按列名）；未配置的列用默认宽 */
  browserColWidths: Partial<Record<BrowserColumn, number>>
  /** 首页三个数字列宽（未学习/学习中/待复习） */
  homeColWidths: number[]
  /** 卡片弹窗子窗口开关状态（载荷由调用方/主进程同步；主窗口无 DOM 弹窗，只有状态镜像） */
  dialog: DialogState | null
  /** 卡片内容版本号：编辑弹窗确认后 +1，学习页据此就地重取当前卡（phase 不复位） */
  contentEpoch: number
  /** 工作区数据版本号：主进程热加载（git pull 等外部变更）完成后 +1，当前视图据此重取数据 */
  dataEpoch: number
  setTab: (t: Tab) => void
  reload: () => Promise<void>
  bumpContent: () => void
  bumpData: () => void
  setSelectedDeck: (id: string | null) => void
  enterStudy: (deckId: string) => void
  /** deckId 缺省 = 保持当前选择；null = 显式选「全部牌组」 */
  openBrowser: (deckId?: string | null, focusCardId?: string | null) => void
  openDialog: (d: DialogState) => void
  closeDialog: () => void
  setStudyCurrentCardId: (id: string | null) => void
  setBrowserKeywords: (kw: string) => void
  setBrowserSelectedId: (id: string | null) => void
  setBrowserSideWidth: (w: number) => void
  setBrowserGridWidth: (w: number | null) => void
  setBrowserColWidth: (col: BrowserColumn, w: number) => void
  setHomeColWidth: (idx: number, w: number) => void
}

export const useApp = create<AppStore>((set) => ({
  tab: 'home',
  decks: [],
  todayCount: 0,
  totalCount: 0,
  config: null,
  selectedDeckId: null,
  studyDeckId: null,
  studyCurrentCardId: null,
  browserDeckId: null,
  browserFocusCardId: null,
  browserKeywords: '',
  browserSelectedId: null,
  browserRestored: false,
  browserSideWidth: 220,
  browserGridWidth: null,
  browserColWidths: {},
  homeColWidths: [110, 110, 110],
  dialog: null,
  contentEpoch: 0,
  dataEpoch: 0,

  setTab: (t) => set({ tab: t }),

  bumpContent: () => set((s) => ({ contentEpoch: s.contentEpoch + 1 })),

  bumpData: () => set((s) => ({ dataEpoch: s.dataEpoch + 1 })),

  reload: async () => {
    const { decks, todayCount, totalCount, config } = await window.miki.loadWorkspace()
    set((s) => {
      // 首次加载：恢复上次离开卡片库时的选中态（跨启动持久化在 config.browser）
      const restore = s.browserRestored
        ? {}
        : {
            browserDeckId: config.browser.selectedDeckId ?? null,
            browserSelectedId: config.browser.selectedCardId ?? null,
            browserRestored: true
          }
      return {
        decks,
        todayCount,
        totalCount,
        config,
        selectedDeckId:
          s.selectedDeckId && decks.some((d) => d.id === s.selectedDeckId) ? s.selectedDeckId : decks[0]?.id ?? null,
        ...restore
      }
    })
  },

  setSelectedDeck: (id) => set({ selectedDeckId: id }),

  enterStudy: (deckId) => set({ tab: 'study', selectedDeckId: deckId, studyDeckId: deckId }),

  openBrowser: (deckId, focusCardId) =>
    set((s) => ({
      tab: 'browser',
      browserDeckId: deckId === undefined ? s.browserDeckId : deckId,
      browserFocusCardId: focusCardId ?? null
    })),

  /** 请求打开卡片弹窗子窗口：本地立即记状态（快捷键屏蔽不再等 IPC 往返），真实窗口由主进程管理 */
  openDialog: (d) => {
    set({ dialog: d })
    void window.miki.openCardDialog(dialogToPayload(d))
  },
  /** 关闭卡片弹窗子窗口（主窗口 Esc 触达；弹窗内取消走 CardForm 的 onCancelled） */
  closeDialog: () => {
    set({ dialog: null })
    void window.miki.closeCardDialog()
  },
  setStudyCurrentCardId: (id) => set({ studyCurrentCardId: id }),
  setBrowserKeywords: (kw) => set({ browserKeywords: kw }),
  setBrowserSelectedId: (id) => set({ browserSelectedId: id }),
  setBrowserSideWidth: (w) => set({ browserSideWidth: Math.min(420, Math.max(150, w)) }),
  setBrowserGridWidth: (w) => set({ browserGridWidth: w == null ? null : Math.min(1400, Math.max(320, w)) }),
  setBrowserColWidth: (col, w) =>
    set((s) => ({ browserColWidths: { ...s.browserColWidths, [col]: Math.min(720, Math.max(60, w)) } })),
  setHomeColWidth: (idx, w) =>
    set((s) => ({
      homeColWidths: s.homeColWidths.map((v, i) => (i === idx ? Math.min(360, Math.max(64, w)) : v))
    }))
}))

/** 牌组统一展示序：名称自然序（数字感知，`1 xxx` 排在 `2 xxx` 前）——首页表格与卡片库树/菜单共用 */
export function sortedDecks(decks: DeckInfo[]): DeckInfo[] {
  return [...decks].sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true }))
}

/** NF3：输入控件聚焦时单字母快捷键失效 */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  return (
    t.tagName === 'INPUT' ||
    t.tagName === 'TEXTAREA' ||
    t.tagName === 'SELECT' ||
    t.isContentEditable
  )
}
