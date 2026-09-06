// 全局状态：tab 路由、牌组列表、选中态、跨页焦点与界面布局
import { create } from 'zustand'
import type { BrowserColumn, DeckInfo, MikiConfig } from '../../shared/types'

export type Tab = 'home' | 'study' | 'browser' | 'stats' | 'settings'

export interface DialogState {
  mode: 'add' | 'edit'
  deckId: string | null
  cardId: string | null // edit 模式
}

interface AppStore {
  tab: Tab
  decks: DeckInfo[]
  todayCount: number
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
  /** 卡片库布局：左栏宽 / 表格宽（px），跨页保持 */
  browserSideWidth: number
  browserGridWidth: number | null
  /** 卡片库列宽（px，按列名）；未配置的列用默认宽 */
  browserColWidths: Partial<Record<BrowserColumn, number>>
  /** 首页三个数字列宽（未学习/学习中/待复习） */
  homeColWidths: number[]
  dialog: DialogState | null
  setTab: (t: Tab) => void
  reload: () => Promise<void>
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
  config: null,
  selectedDeckId: null,
  studyDeckId: null,
  studyCurrentCardId: null,
  browserDeckId: null,
  browserFocusCardId: null,
  browserKeywords: '',
  browserSelectedId: null,
  browserSideWidth: 220,
  browserGridWidth: null,
  browserColWidths: {},
  homeColWidths: [110, 110, 110],
  dialog: null,

  setTab: (t) => set({ tab: t }),

  reload: async () => {
    const { decks, todayCount, config } = await window.miki.loadWorkspace()
    set((s) => ({
      decks,
      todayCount,
      config,
      selectedDeckId:
        s.selectedDeckId && decks.some((d) => d.id === s.selectedDeckId) ? s.selectedDeckId : decks[0]?.id ?? null
    }))
  },

  setSelectedDeck: (id) => set({ selectedDeckId: id }),

  enterStudy: (deckId) => set({ tab: 'study', selectedDeckId: deckId, studyDeckId: deckId }),

  openBrowser: (deckId, focusCardId) =>
    set((s) => ({
      tab: 'browser',
      browserDeckId: deckId === undefined ? s.browserDeckId : deckId,
      browserFocusCardId: focusCardId ?? null
    })),

  openDialog: (d) => set({ dialog: d }),
  closeDialog: () => set({ dialog: null }),
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
