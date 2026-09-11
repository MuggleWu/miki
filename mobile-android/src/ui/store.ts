// 移动端全局状态。
//
// 与桌面端一致用 zustand，但两点必要的差异：
// 1. 工作区的初始化是**异步**的（Capacitor 文件系统是 Promise API），桌面端是同步 init。
//    所以页面一律要处理 ws === null 的「还没起来」态。
// 2. MobileWorkspace 是可变对象（内存态即缓存），zustand 感知不到它内部的变化。
//    所以每次写操作后显式 bump() 一个 version 计数器，页面用它做派生数据的重算依赖。
//    这比给整个工作区做不可变快照便宜得多——数据量级是几千张卡。
import { create } from 'zustand'
import { CapacitorFileStore } from '@mobile/fs'
import { MobilePaths } from '@mobile/paths'
import { MobileWorkspace } from '@mobile/workspace'
import { WORKSPACE_DIR } from '@mobile/constants'
import { PREF_KEYS, prefGet, prefSet } from '@mobile/prefs'
import type { FontScale, ThemePref } from '@mobile/theme'

/** 本机显示偏好（不是工作区数据，换手机不会跟着走） */
export interface Prefs {
  theme: ThemePref
  fontScale: FontScale
  keepAwake: boolean
}

const DEFAULT_PREFS: Prefs = { theme: 'system', fontScale: 'medium', keepAwake: true }

/** 路由：够用就好的自研栈（页面数量是个位数，不值得引入 react-router） */
export type Route =
  | { kind: 'decks' }
  | { kind: 'study'; deckId: string }
  | { kind: 'library' }
  | { kind: 'stats' }
  | { kind: 'settings' }
  | { kind: 'selfcheck' }
  | { kind: 'cardEdit'; cardId: string; from: Route }

interface AppState {
  ws: MobileWorkspace | null
  /** 启动失败（工作区打不开这类硬错误）：整屏显示，不做静默降级 */
  bootError: string | null
  prefs: Prefs
  route: Route
  stack: Route[]
  toast: string | null
  /** 写操作计数器：页面把它放进 useMemo 依赖，驱动派生数据重算 */
  version: number

  boot(): Promise<void>
  loadPrefs(): Promise<void>
  setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): Promise<void>
  go(route: Route): void
  /** 抽屉里换页：直接落位并把返回栈清空（同级页之间不该来回叠栈） */
  reset(route: Route): void
  back(): void
  notify(msg: string | null): void
  bump(): void
}

export const useApp = create<AppState>((set, get) => ({
  ws: null,
  bootError: null,
  prefs: DEFAULT_PREFS,
  route: { kind: 'decks' },
  stack: [],
  toast: null,
  version: 0,

  async boot() {
    try {
      const store = new CapacitorFileStore()
      const ws = new MobileWorkspace(store, new MobilePaths(WORKSPACE_DIR))
      await ws.init()
      set({ ws, bootError: null })
    } catch (e) {
      set({ bootError: e instanceof Error ? e.message : String(e) })
    }
  },

  async loadPrefs() {
    const [theme, fontScale, keepAwake] = await Promise.all([
      prefGet(PREF_KEYS.theme),
      prefGet(PREF_KEYS.fontScale),
      prefGet(PREF_KEYS.keepAwake)
    ])
    set({
      prefs: {
        theme: theme === 'light' || theme === 'dark' || theme === 'system' ? theme : DEFAULT_PREFS.theme,
        fontScale:
          fontScale === 'small' || fontScale === 'medium' || fontScale === 'large'
            ? fontScale
            : DEFAULT_PREFS.fontScale,
        keepAwake: keepAwake === null ? DEFAULT_PREFS.keepAwake : keepAwake === '1'
      }
    })
  },

  async setPref(key, value) {
    set({ prefs: { ...get().prefs, [key]: value } })
    // 落盘失败不影响本次生效（本次会话已经改过了），只是下次启动会回到旧值
    await prefSet(PREF_KEYS[key], typeof value === 'boolean' ? (value ? '1' : '0') : String(value))
  },

  go(route) {
    const cur = get().route
    // 编辑页记着来路：保存返回时回到原来那一屏（可能是学习页，也可能是卡片库）
    const entry = route.kind === 'cardEdit' ? route.from : cur
    set({ route, stack: [...get().stack, entry], toast: null })
  },

  reset(route) {
    set({ route, stack: [], toast: null })
  },

  back() {
    const stack = get().stack
    const prev = stack.length > 0 ? stack[stack.length - 1] : { kind: 'decks' as const }
    set({ route: prev, stack: stack.slice(0, -1), toast: null })
  },

  notify(msg) {
    set({ toast: msg })
  },

  bump() {
    set({ version: get().version + 1 })
  }
}))
