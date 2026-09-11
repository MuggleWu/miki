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
import { prefetchMarkdown } from './md'
import {
  clearCreds,
  credsStatus,
  loadBase,
  loadCreds,
  loadLastSyncAt,
  loadVerify,
  saveBase,
  saveCreds,
  saveLastSyncAt,
  saveVerify,
  type SyncCredsStatus,
  type VerifyRecord
} from '@mobile/sync/creds'
import { runSync } from '@mobile/sync'
import { GithubClient } from '@mobile/sync/github'
import type { SyncReport } from '@mobile/sync/types'
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

/** 同步在本机可见的状态（凭据只以脱敏形态进内存，原文只在 creds 模块内出现） */
export interface SyncUiState {
  status: SyncCredsStatus | null
  verify: VerifyRecord | null
  report: SyncReport | null
  lastSyncAt: number | null
  /** 正在同步：按钮要禁掉，避免并发推两条 commit */
  busy: boolean
  /** 上次同步的结论（成功/失败/被拦下），牌组页横幅据此提示 */
  lastError: string | null
}

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
  sync: SyncUiState

  boot(): Promise<void>
  loadPrefs(): Promise<void>
  setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): Promise<void>
  go(route: Route): void
  /** 抽屉里换页：直接落位并把返回栈清空（同级页之间不该来回叠栈） */
  reset(route: Route): void
  back(): void
  notify(msg: string | null): void
  bump(): void

  /** 读本机同步配置与上次结果（启动、进设置页时调用） */
  loadSyncInfo(): Promise<void>
  /** 保存仓库/分支/PAT 并立刻验证一次连接 */
  saveSyncConfig(repo: string, branch: string, token: string | null): Promise<void>
  clearSyncCreds(): Promise<void>
  /** 手动同步：拉取 → 合并 → 推送（设计文档：推送只在你点它时发生） */
  syncNow(manual: boolean): Promise<SyncReport | null>
}

export const useApp = create<AppState>((set, get) => ({
  ws: null,
  bootError: null,
  prefs: DEFAULT_PREFS,
  route: { kind: 'decks' },
  stack: [],
  toast: null,
  version: 0,
  sync: { status: null, verify: null, report: null, lastSyncAt: null, busy: false, lastError: null },

  async boot() {
    try {
      const store = new CapacitorFileStore()
      const ws = new MobileWorkspace(store, new MobilePaths(WORKSPACE_DIR))
      await ws.init()
      // 从脚本开始执行到工作区就绪的墙钟差：这是"打开应用要等多久"的实际口径
      console.log(`[miki-boot] JS 启动 → 工作区就绪：${Math.round(performance.now())}ms`)
      set({ ws, bootError: null })
      // 工作区就绪后再预取 markdown 管线：首屏不受它影响，进牌组时通常已经就位
      prefetchMarkdown()
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

  async loadSyncInfo() {
    const [status, verify, lastSyncAt] = await Promise.all([credsStatus(), loadVerify(), loadLastSyncAt()])
    set({ sync: { ...get().sync, status, verify, lastSyncAt } })
  },

  async saveSyncConfig(repo, branch, token) {
    await saveCreds(repo, branch, token)
    await get().loadSyncInfo()
    // 存了就去验一次：让用户立刻知道这串 token 到底能不能用，而不是等到刷卡后同步失败
    const { repo: r, branch: b, token: t } = await loadCreds()
    if (t) {
      const res = await new GithubClient({ repo: r, branch: b, token: t }).verify()
      const rec: VerifyRecord = { at: Date.now(), ok: res.ok, message: res.message }
      await saveVerify(rec)
      set({ sync: { ...get().sync, verify: rec } })
    }
  },

  async clearSyncCreds() {
    await clearCreds()
    await get().loadSyncInfo()
    get().notify('已清空 GitHub 凭据')
  },

  async syncNow(manual) {
    const { ws, sync } = get()
    if (!ws || sync.busy) return null
    const { repo, branch, token } = await loadCreds()
    if (!token) {
      set({ sync: { ...get().sync, lastError: '还没有配置 GitHub 凭据' } })
      if (manual) get().notify('还没配置同步：去设置页填仓库与 PAT')
      return null
    }
    set({ sync: { ...get().sync, busy: true, lastError: null } })
    try {
      const base = await loadBase()
      const outcome = await runSync(
        {
          store: new CapacitorFileStore(),
          paths: new MobilePaths(WORKSPACE_DIR),
          // 重放校验：落地后整份重载，回报事件条数与坏行数（校验不过 runSync 会抛）
          reloadAndVerify: async () => {
            await ws.reload()
            const dmg = ws.damageReport()
            return {
              eventCount: ws.loadTimingReport()?.eventCount ?? 0,
              damaged: dmg.damagedLines,
              truncated: dmg.truncatedFiles.length,
              cards: ws.cardCount()
            }
          }
        },
        { repo, branch, token },
        base
      )
      await saveBase(outcome.base)
      await saveLastSyncAt(outcome.report.at)
      set({
        sync: {
          ...get().sync,
          busy: false,
          report: outcome.report,
          lastSyncAt: outcome.report.at,
          lastError: outcome.report.ok ? null : outcome.report.message
        }
      })
      get().bump()
      if (manual) get().notify(outcome.report.message)
      return outcome.report
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 401/403 说明凭据废了：横幅要立刻出现，而不是等用户下次点同步才知道
      const stale = /（401）|（403）/.test(msg)
      set({
        sync: {
          ...get().sync,
          busy: false,
          lastError: msg,
          verify: stale ? { at: Date.now(), ok: false, message: msg } : get().sync.verify
        }
      })
      if (stale) await saveVerify({ at: Date.now(), ok: false, message: msg })
      if (manual) get().notify(`同步失败：${msg}`)
      return null
    }
  },

  bump() {
    set({ version: get().version + 1 })
  }
}))
