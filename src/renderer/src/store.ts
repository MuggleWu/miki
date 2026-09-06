// 全局状态：tab 路由、牌组列表、选中态、跨页焦点
import { create } from 'zustand'
import type { DeckInfo, MikiConfig } from '../../shared/types'

export type Tab = 'home' | 'study' | 'browser' | 'stats'

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
  dialog: DialogState | null
  setTab: (t: Tab) => void
  reload: () => Promise<void>
  setSelectedDeck: (id: string | null) => void
  enterStudy: (deckId: string) => void
  openBrowser: (deckId: string | null, focusCardId?: string | null) => void
  openDialog: (d: DialogState) => void
  closeDialog: () => void
  setStudyCurrentCardId: (id: string | null) => void
  setBrowserKeywords: (kw: string) => void
  setBrowserSelectedId: (id: string | null) => void
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
    set({ tab: 'browser', browserDeckId: deckId, browserFocusCardId: focusCardId ?? null }),

  openDialog: (d) => set({ dialog: d }),
  closeDialog: () => set({ dialog: null }),
  setStudyCurrentCardId: (id) => set({ studyCurrentCardId: id }),
  setBrowserKeywords: (kw) => set({ browserKeywords: kw }),
  setBrowserSelectedId: (id) => set({ browserSelectedId: id })
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
