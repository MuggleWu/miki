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
  applySyncConfig,
  clearCreds,
  credsStatus,
  loadBase,
  loadCreds,
  loadLastSyncAt,
  loadVerify,
  saveBase,
  saveLastSyncAt,
  saveVerify,
  type SyncCredsStatus,
  type VerifyRecord
} from '@mobile/sync/creds'
import { runSync } from '@mobile/sync'
import { GithubClient } from '@mobile/sync/github'
import type { SyncMode } from '@mobile/sync'
import type { SyncReport } from '@mobile/sync/types'
import type { FontScale, ThemePref } from '@mobile/theme'
import { shouldSnapOpen } from './edge-swipe'

/** 与 styles.css 里 .drawer 的 transition 时长一致：吸附动画跑完再改 open 状态 */
const DRAWER_SETTLE_MS = 200

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
  /** 左侧抽屉是否打开。放在全局而不是某个页面里：汉堡按钮与「左边缘右滑」都要能拉起它 */
  drawerOpen: boolean
  /** 抽屉宽度（px）。CSS 写的是 min(78vw, 320px)，挂载后由 Drawer 实测写回 */
  drawerWidth: number
  /** 拖动中的横向偏移：0 = 全开，-drawerWidth = 全收起。null = 没在拖（交给 CSS 动画） */
  drawerDrag: number | null
  /** 手指是否还按着。按着时不能有过渡，否则跟手会滞后一帧 */
  drawerDragging: boolean
  /** 入场动画的代号：任何一次拖动/吸附都会 ++，用于作废尚未落地的入场回调 */
  enterSeq: number
  /**
   * 已打开弹层（含抽屉）的"关闭"回调，后进先出。返回键要先关最上面这层，再退路由——
   * 否则弹层开着按返回会直接退出整个页面，用户得重新点进来。弹层是各页面自己的 state，
   * 返回键（原生事件）看不到，只能由弹层自己登记。
   */
  sheetStack: (() => void)[]
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
  setDrawer(open: boolean): void
  setDrawerDrag(offset: number, dragging?: boolean): void
  setDrawerWidth(width: number): void
  /** 松手：甩得够快按方向定，否则按落点（过半）定——两个方向都带动画 */
  settleDrawer(release?: { velocity: number; travelled: number }): void
  /** 点遮罩 / 返回键 / 选中条目：动画收起 */
  closeDrawer(): void
  /** 弹层打开/关闭时登记，配合返回键使用 */
  pushSheet(close: () => void): void
  popSheet(close: () => void): void
  /** 关掉最上面的弹层；没有弹层时返回 false（调用方接着按路由后退处理） */
  closeTopSheet(): boolean
  bump(): void

  /** 读本机同步配置与上次结果（启动、进设置页时调用） */
  loadSyncInfo(): Promise<void>
  /** 保存仓库/分支/PAT 并立刻验证一次连接 */
  saveSyncConfig(repo: string, branch: string, token: string | null): Promise<void>
  clearSyncCreds(): Promise<void>
  /** 手动同步：拉取 → 合并 → 推送（设计文档：推送只在你点它时发生） */
  /**
   * 同步。`mode` 是**唯一**的方向开关：
   * - 'pull-only'：只拉、不产生 commit（回前台的自动同步走它，静默，不弹提示）；
   * - 'full'：拉 + 推（只有用户点"推送进度 / 立即同步"才走它），并有提示。
   * 以前这里是 `manual: boolean`，但 direction 并没有真的传下去——回前台那次也照样推送。
   */
  syncNow(mode: SyncMode): Promise<SyncReport | null>
}

export const useApp = create<AppState>((set, get) => ({
  ws: null,
  bootError: null,
  prefs: DEFAULT_PREFS,
  route: { kind: 'decks' },
  stack: [],
  toast: null,
  drawerOpen: false,
  drawerWidth: 320,
  drawerDrag: null,
  drawerDragging: false,
  enterSeq: 0,
  sheetStack: [],
  version: 0,
  sync: { status: null, verify: null, report: null, lastSyncAt: null, busy: false, lastError: null },

  async boot() {
    try {
      const store = new CapacitorFileStore()
      const ws = new MobileWorkspace(store, new MobilePaths(WORKSPACE_DIR))
      await ws.init()
      // 从脚本开始执行到工作区就绪的墙钟差：这是"打开应用要等多久"的实际口径。
      // 分阶段数字只进日志、不进界面——设置页以前把它们摊给用户看，属于暴露过多内部信息。
      const t = ws.loadTimingReport()
      console.log(
        `[miki-boot] JS 启动 → 工作区就绪：${Math.round(performance.now())}ms` +
          (t
            ? `（config ${t.config} / 牌组 ${t.decks} / 卡片 ${t.cards} / 重放 ${t.events}（${t.eventCount} 条事件）/ 建索引 ${t.index}）`
            : '')
      )
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
  setDrawer(open) {
    // 点汉堡/菜单键进来：从屏幕外滑到位。
    //
    // 这里用**过渡**而不是 CSS keyframe 动画，是有教训的：动画期间拖动要把它关掉
    // （.dragging 上写 animation: none），而松手时 .dragging 一移除，animation-name 从
    // none 变回 drawer-in 会被浏览器当成一段**新动画**重新开始——面板先跳回屏幕外再滑进来，
    // 用户看到的就是"松手时抖动"。改成一进一出都走 transform 过渡后，同一条机制没有
    // 可被重启的动画，松手只会从当前位置平滑滑到落点。
    if (!open) {
      set({ drawerOpen: false, drawerDrag: null, drawerDragging: false })
      return
    }
    if (get().drawerOpen) {
      // 已经开着（比如手势拖动中又调了一次）：不要重播入场
      set({ drawerDragging: false })
      return
    }
    const width = get().drawerWidth
    const seq = get().enterSeq + 1
    set({ drawerOpen: true, drawerDrag: -width, drawerDragging: false, enterSeq: seq })
    // 双 rAF：第一帧让浏览器真正把"停在屏幕外"渲染出来，第二帧再改目标值，
    // 过渡才有起点。合成一次更新的话过渡不会触发，会直接"啪"地出现。
    //
    // 为什么用代号而不是"偏移是否还等于 -width"来判断"期间有没有被接管"：关闭吸附的
    // 目标值**也是** -width，两者会撞上——真实发生过的竞态是"轻轻一甩本该关闭，抽屉却
    // 反而弹开"：settle 把偏移设成 -width 之后，这两帧 rAF 才跑到，看到的哨兵正好成立，
    // 于是把偏移改成 0（= 全开），而 settle 的收尾又因为偏移已被改掉而放弃关闭。
    // 任何一次拖动或吸附都会递增 enterSeq，过期的回调自己就不干活了。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const st = get()
        if (st.enterSeq !== seq || !st.drawerOpen || st.drawerDrag !== -width) return
        set({ drawerDrag: 0 })
        setTimeout(() => {
          const after = get()
          if (after.enterSeq === seq && after.drawerOpen && after.drawerDrag === 0) set({ drawerDrag: null })
        }, DRAWER_SETTLE_MS)
      })
    })
  },

  setDrawerWidth(width) {
    if (width > 0 && Math.abs(width - get().drawerWidth) > 1) set({ drawerWidth: width })
  },

  setDrawerDrag(offset, dragging = true) {
    // 拖动/吸附一律作废尚未落地的入场动画（见 setDrawer 里那段注释）
    set({ drawerDrag: offset, drawerDragging: dragging, enterSeq: get().enterSeq + 1 })
  },

  settleDrawer(release) {
    const { drawerDrag, drawerWidth, setDrawerDrag } = get()
    if (drawerDrag === null) return
    // 先看甩动速度（轻轻一甩就按方向定），没有速度才退回"过半"的位置判定
    const open = shouldSnapOpen(drawerDrag, drawerWidth, release?.velocity ?? 0, release?.travelled ?? 0)
    const target = open ? 0 : -drawerWidth
    setDrawerDrag(target, false) // 松手后开过渡，滑到落点
    setTimeout(() => {
      // 动画期间用户又动了（偏移已不是那个落点）就不要覆盖他的状态
      if (get().drawerDrag !== target) return
      set({ drawerDrag: null, drawerDragging: false, drawerOpen: open })
    }, DRAWER_SETTLE_MS)
  },

  closeDrawer() {
    const { drawerOpen, drawerWidth, setDrawerDrag } = get()
    if (!drawerOpen) return
    setDrawerDrag(-drawerWidth, false)
    setTimeout(() => {
      if (get().drawerDrag !== -drawerWidth) return
      set({ drawerOpen: false, drawerDrag: null, drawerDragging: false })
    }, DRAWER_SETTLE_MS)
  },

  async loadSyncInfo() {
    const [status, verify, lastSyncAt] = await Promise.all([credsStatus(), loadVerify(), loadLastSyncAt()])
    set({ sync: { ...get().sync, status, verify, lastSyncAt } })
  },

  async saveSyncConfig(repo, branch, token) {
    // 换仓库/分支的后果（作废同步记账）封装在 applySyncConfig 里，并有测试钉住
    const { creds } = await applySyncConfig(repo, branch, token)
    await get().loadSyncInfo()
    // 存了就去验一次：让用户立刻知道这串 token 到底能不能用，而不是等到刷卡后同步失败
    if (creds.token) {
      const res = await new GithubClient({ repo: creds.repo, branch: creds.branch, token: creds.token }).verify()
      const rec: VerifyRecord = { at: Date.now(), ok: res.ok, message: res.message, kind: res.kind }
      await saveVerify(rec)
      set({ sync: { ...get().sync, verify: rec } })
    }
  },

  async clearSyncCreds() {
    await clearCreds()
    await get().loadSyncInfo()
    get().notify('已清空 GitHub 凭据')
  },

  async syncNow(mode) {
    const { ws, sync } = get()
    if (!ws || sync.busy) return null
    const { repo, branch, token } = await loadCreds()
    if (!token) {
      set({ sync: { ...get().sync, lastError: '还没有配置 GitHub 凭据' } })
      if (mode === 'full') get().notify('还没配置同步：去设置页填仓库与 PAT')
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
        base,
        mode
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
      if (mode === 'full') get().notify(outcome.report.message)
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
      if (mode === 'full') get().notify(`同步失败：${msg}`)
      return null
    }
  },

  pushSheet(close) {
    set({ sheetStack: [...get().sheetStack, close] })
  },

  popSheet(close) {
    set({ sheetStack: get().sheetStack.filter((c) => c !== close) })
  },

  closeTopSheet() {
    const stack = get().sheetStack
    if (stack.length === 0) return false
    stack[stack.length - 1]() // 回调自己会把这一层从栈里摘掉
    return true
  },

  bump() {
    set({ version: get().version + 1 })
  }
}))
