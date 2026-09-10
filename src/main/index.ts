import { app, BrowserWindow, dialog, ipcMain, nativeTheme, screen, shell } from 'electron'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { WorkspaceService } from './workspace'
import { startApiServer } from './api-server'
import { CardDialogManager, type CardDialogWindowLike } from './card-dialog'
import { WorkspaceManager } from './workspace-manager'
import { atomicWrite } from './atomic-write'
import { IPC, pickRendererWritableConfig } from '../shared/ipc'
import { withCardDialogHash } from '../shared/card-dialog'
import { defaultWorkspaceSuggestion } from '../shared/workspace'
import type {
  DueFilter,
  MikiConfig,
  QueryParams,
  QueryState,
  Rating,
  SortKey,
  StatsParams,
  WindowState
} from '../shared/types'

let ws: WorkspaceService
let win: BrowserWindow | null = null
let dialogManager: CardDialogManager | null = null
let workspaceManager: WorkspaceManager
/** 工作区是否已完成初始化（首次启动引导确认前为 false，期间渲染层显示引导页） */
let workspaceReady = false
let apiServer: ReturnType<typeof startApiServer> | null = null

/** 与 styles.css [data-theme] 一致的窗口启动底色，避免加载闪烁 */
const WINDOW_BG: Record<'light' | 'dark', string> = { dark: '#101014', light: '#f5f6f8' }

// 原生头行（系统标题栏）颜色跟随应用内主题：themeSource 影响原生控件外观，
// 与渲染层 data-theme 同源（config.theme），避免深色内容配浅色头行
function applyNativeTheme(theme: 'light' | 'dark'): void {
  nativeTheme.themeSource = theme
}

/** userData 指针文件：当前用哪个工作区 + 已记住的多工作区列表（多用户档案） */
function pointerFile(): string {
  return path.join(app.getPath('userData'), 'workspace.json')
}

/** 点标题栏（尤其从别的窗口切回来时）webContents 可能不是 firstResponder，
 * 键盘（Esc、输入）会整体失灵；窗口每次聚焦把焦点补回渲染层 */
function keepWebContentsFocused(w: BrowserWindow): void {
  w.on('focus', () => {
    if (!w.isDestroyed() && !w.webContents.isFocused()) w.webContents.focus()
  })
}

/** 工作区确定后初始化服务并启动热加载与 HTTP API（首次引导路径在确认后才调用） */
function startServices(root: string): void {
  ws.init(root)
  workspaceReady = true

  // 工作区热加载：git pull / 他机写入后主进程自动重载内存态，通知渲染进程刷新当前视图
  ws.onExternalChange(() => {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.workspaceChanged)
    dialogManager?.relayWorkspaceChanged() // 弹窗窗口的牌组下拉同步刷新
  })
  // 热加载会作废本会话撤销栈（外部变更后旧撤销目标可能已失效）。静默作废在键盘上表现为
  // 「⌘Z 没反应」，所以把丢掉的步数显式告诉 UI 提示一次
  ws.onUndoDiscarded((dropped) => {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.undoDiscarded, dropped)
  })
  ws.startWatching()

  // 运行时端口文件放 userData（非工作区）：记录实际监听端口，供 MCP wrapper 等外部工具自动发现
  apiServer = startApiServer(ws, { runtimeInfoPath: path.join(app.getPath('userData'), 'miki-api.json') })
}

/** 恢复上次窗口状态：把保存的普通态 bounds 钳回可见显示器的工作区（外接屏拔掉/分辨率变化时不出屏） */
function clampToWorkArea(st: WindowState): { x?: number; y?: number; width: number; height: number } {
  const width = Math.min(st.width, 10_000)
  const height = Math.min(st.height, 10_000)
  const wa = screen.getDisplayMatching({ x: st.x ?? 0, y: st.y ?? 0, width, height }).workArea
  const w = Math.min(width, wa.width)
  const h = Math.min(height, wa.height)
  return {
    x: st.x == null ? undefined : Math.min(Math.max(st.x, wa.x), wa.x + wa.width - w),
    y: st.y == null ? undefined : Math.min(Math.max(st.y, wa.y), wa.y + wa.height - h),
    width: w,
    height: h
  }
}

function createWindow(): void {
  // 引导阶段 ws 尚未 init（无 config）：按默认尺寸居中建窗，让引导页有宿主；
  // 主题在引导期走系统外观，确认工作区后由 ws.config 接管
  const st: WindowState = workspaceReady
    ? ws.config.window
    : { x: null, y: null, width: 1280, height: 840, maximized: false }
  const restored = clampToWorkArea(st)
  const theme: 'light' | 'dark' = workspaceReady ? ws.config.theme : nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  applyNativeTheme(theme)
  win = new BrowserWindow({
    x: restored.x,
    y: restored.y,
    width: restored.width,
    height: restored.height,
    minWidth: 960,
    minHeight: 600,
    title: 'Miki',
    // 与主题一致的启动底色，避免加载闪烁
    backgroundColor: WINDOW_BG[theme],
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  // 上次是最大化：先按普通尺寸建窗再最大化（resize 回调里 getNormalBounds 仍取普通态，不会污染尺寸）
  if (workspaceReady && ws.config.window.maximized) win.maximize()

  keepWebContentsFocused(win)

  // 窗口尺寸/位置/最大化 → 工作区 config.json（防抖落盘；关闭时立即补一次）
  const persistBounds = () => {
    if (!win || win.isDestroyed()) return
    const nb = win.getNormalBounds()
    ws.saveConfig({ window: { x: nb.x, y: nb.y, width: nb.width, height: nb.height, maximized: win.isMaximized() } })
  }
  let saveTimer: NodeJS.Timeout | null = null
  const schedulePersist = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(persistBounds, 800)
  }
  win.on('resize', schedulePersist)
  win.on('move', schedulePersist)
  win.on('maximize', persistBounds)
  win.on('unmaximize', persistBounds)
  win.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer)
    persistBounds()
  })

  // 外部内容一律交系统浏览器：窗口只加载本应用页面，防止外部网页拿到 preload 注入的 IPC 面
  win.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (url.startsWith('file:') || (devUrl && url.startsWith(devUrl))) return
    e.preventDefault()
    void shell.openExternal(url)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function dialogUrl(): string {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  return withCardDialogHash(devUrl ? `${devUrl}/` : `file://${path.join(__dirname, '../renderer/index.html')}`)
}

function setupCardDialogManager(): void {
  dialogManager = new CardDialogManager({
    createWindow: ({ bounds, title }) => {
      const dw = new BrowserWindow({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        minWidth: 520,
        minHeight: 380,
        title,
        // 不设 parent：父子关系会强制子窗口常驻父窗之上（点父窗也压不下去），与常规 z 序相悖；
        // 主窗口关闭时已在其 closed 事件里显式关掉本窗，不依赖父子联动
        show: false, // ready-to-show 后再显示，避免白窗闪烁
        backgroundColor: WINDOW_BG[ws.config.theme],
        webPreferences: {
          preload: path.join(__dirname, '../preload/index.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      })
      // 弹窗窗口内的外部导航一律拒掉（同主窗口策略；正常流程不会发生）
      dw.webContents.on('will-navigate', (e) => e.preventDefault())
      dw.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      keepWebContentsFocused(dw)
      return dw as unknown as CardDialogWindowLike
    },
    getParentBounds: () => {
      if (!win || win.isDestroyed()) return null
      const b = win.getBounds()
      return { x: b.x, y: b.y, width: b.width, height: b.height }
    },
    getWorkArea: (parent) => screen.getDisplayMatching(parent).workArea,
    getSavedBounds: () => ws.config.cardDialogWindow,
    buildUrl: dialogUrl,
    notifyMainWindow: (channel, ...args) => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
    },
    saveBounds: (b) => ws.saveConfig({ cardDialogWindow: b })
  })

  const mgr = dialogManager as CardDialogManager // 以下 handler 均在 setup 完成后才会被调用
  ipcMain.handle(IPC.openCardDialog, (_e, payload: unknown) => {
    mgr.open(payload)
  })
  ipcMain.handle(IPC.closeCardDialog, () => {
    mgr.close()
  })
  ipcMain.handle(IPC.notifyCardsChanged, (_e, kind: unknown) => {
    mgr.notifyCardsChanged(kind)
  })
}

app.whenReady().then(() => {
  // 单实例锁：双开（Raycast/Dock 启动 + dev 实例）会并发写同一工作区的事件日志与检查点
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  // 开发模式下 dock 没有打包后的 icns 可用，手动铺上应用图标
  if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
    app.dock.setIcon(path.join(app.getAppPath(), 'resources/icon.png'))
  }

  ws = new WorkspaceService()

  // 多工作区（多用户档案）管理：指针文件 = userData/workspace.json，旧 {workspacePath} 格式自动升级
  workspaceManager = new WorkspaceManager({
    readPointer: () => {
      try {
        return JSON.parse(fs.readFileSync(pointerFile(), 'utf-8'))
      } catch {
        return null
      }
    },
    writePointer: (reg) => atomicWrite(pointerFile(), JSON.stringify(reg, null, 2)),
    isDirectory: (p) => {
      try {
        return fs.statSync(p).isDirectory()
      } catch {
        return false
      }
    },
    makeDirectory: (p) => fs.mkdirSync(p, { recursive: true }),
    defaultSuggestion: () => defaultWorkspaceSuggestion(app.getPath('home'), path.sep),
    now: () => Date.now()
  })

  ipcMain.handle(IPC.dataDamageReport, () => ws.damageReport())
  ipcMain.handle(IPC.workspaceStatus, () => workspaceManager.getStatus(!workspaceReady))
  ipcMain.handle(IPC.workspaceChooseFolder, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return r.canceled || r.filePaths.length === 0 ? null : (r.filePaths[0] ?? null)
  })
  ipcMain.handle(IPC.workspaceConfirm, (_e, p: unknown) => {
    if (workspaceReady) return { ok: true, status: workspaceManager.getStatus(false) }
    if (typeof p !== 'string' || p === '') {
      return { ok: false, error: '路径为空', status: workspaceManager.getStatus(true) }
    }
    const r = workspaceManager.confirmOnboarding(p)
    if (r.ok) startServices(p)
    return { ...r, status: workspaceManager.getStatus(!workspaceReady) }
  })
  ipcMain.handle(IPC.workspaceAdd, (_e, p: unknown) => {
    const r = typeof p === 'string' ? workspaceManager.add(p) : { ok: false, error: '非法路径' }
    return { ...r, status: workspaceManager.getStatus(!workspaceReady) }
  })
  ipcMain.handle(IPC.workspaceSwitch, (_e, p: unknown) => {
    const r = typeof p === 'string' ? workspaceManager.switchTo(p) : { ok: false, error: '非法路径' }
    if (r.ok) {
      // 先回包再重启：渲染层有机会显示「正在重启」提示
      setTimeout(() => {
        app.relaunch()
        app.exit(0)
      }, 200)
    }
    return r
  })
  ipcMain.handle(IPC.workspaceRemove, (_e, p: unknown) => {
    if (typeof p === 'string') void workspaceManager.remove(p)
    return workspaceManager.getStatus(!workspaceReady)
  })
  ipcMain.handle(IPC.workspaceReveal, (_e, p: unknown) => {
    if (typeof p === 'string') shell.showItemInFolder(p)
  })

  // 启动解析：MIKI_WORKSPACE 环境变量 > 指针文件 > 首次启动引导（无有效工作区时不初始化服务）
  const initial = workspaceManager.resolveInitial(process.env.MIKI_WORKSPACE ?? null)
  if (initial) startServices(initial)

  // 以下数据面 handler 都直接读写 ws：引导完成前渲染层只走 workspace 通道（引导页无其他入口），
  // 若在 ws.init 前被调用会因 root/config 未定抛错拒绝，不会产生半初始化写损坏
  ipcMain.handle(IPC.loadWorkspace, () => ({
    decks: ws.deckInfos(),
    todayCount: ws.todayCount(),
    totalCount: ws.totalAnswered(),
    config: ws.config
  }))
  ipcMain.handle(IPC.addDeck, (_e, name: string) => {
    ws.addDeck(name)
    return ws.deckInfos()
  })
  ipcMain.handle(IPC.renameDeck, (_e, id: string, name: string) => {
    ws.renameDeck(id, name)
    return ws.deckInfos()
  })
  ipcMain.handle(IPC.deleteDeck, (_e, id: string) => {
    ws.deleteDeck(id)
    return ws.deckInfos()
  })
  ipcMain.handle(IPC.getStudy, (_e, deckId: string) => ws.getStudy(deckId))
  ipcMain.handle(IPC.answer, (_e, cardId: string, rating: Rating, durationMs?: number) =>
    ws.answer(cardId, rating, durationMs)
  )
  ipcMain.handle(IPC.undo, () => ws.undo())
  ipcMain.handle(IPC.addCard, (_e, deckId: string, front: string, back: string) => ws.addCard(deckId, front, back))
  ipcMain.handle(IPC.updateCard, (_e, cardId: string, patch: { front?: string; back?: string }) =>
    ws.updateCard(cardId, patch)
  )
  ipcMain.handle(
    IPC.updateCardChecked,
    (_e, cardId: string, patch: { front?: string; back?: string }, expectedUpdatedAt: number) =>
      ws.updateCardChecked(cardId, patch, expectedUpdatedAt)
  )
  // 同步版：窗口卸载时渲染层用它把在途编辑交过来。ipcMain.on + returnValue 是 sendSync 的配对写法；
  // 这里刻意同步——异步 invoke 在窗口随后被销毁时不保证写盘完成，用户最后那次编辑会丢。
  ipcMain.on(IPC.flushPendingEdit, (e, cardId: string, patch: { front: string; back: string }) => {
    try {
      ws.updateCard(cardId, patch)
      e.returnValue = true
    } catch {
      // 落盘失败不能让关闭流程卡住：返回 false，由调用方决定是否提示
      e.returnValue = false
    }
  })
  ipcMain.handle(IPC.getCard, (_e, cardId: string) => ws.getCard(cardId))
  ipcMain.handle(IPC.deleteCard, (_e, cardId: string) => ws.deleteCard(cardId))
  ipcMain.handle(IPC.queryCards, (_e, params: QueryParams) => ws.queryCards(params))
  ipcMain.handle(IPC.getStats, (_e, params: StatsParams) => ws.getStats(params))
  ipcMain.handle(
    IPC.saveBrowserConfig,
    (_e, columns: string[], sort: SortKey[], filters?: { stateFilter?: QueryState | null; dueFilter?: DueFilter }) => {
      // 统一走 saveConfig（原子写 + 自写豁免快照）；config.json 含 API token 由 atomicWrite 保持 0600
      ws.saveConfig({
        browser: { columns: columns as MikiConfig['browser']['columns'], sort, ...(filters ?? {}) }
      })
    }
  )
  ipcMain.handle(IPC.saveTheme, (_e, theme: 'light' | 'dark') => {
    ws.saveConfig({ theme })
    applyNativeTheme(theme) // 头行随应用内主题即时切换
  })
  // 渲染层补丁先过白名单再落盘：挡住陈旧 config 快照回写覆盖 api.token/调度参数
  ipcMain.handle(IPC.saveConfig, (_e, patch: Record<string, unknown>) =>
    ws.saveConfig(pickRendererWritableConfig(patch ?? {}))
  )
  ipcMain.handle(IPC.setCardSuspended, (_e, cardId: string, suspended: boolean) =>
    ws.setCardSuspended(cardId, suspended)
  )
  ipcMain.handle(IPC.moveCards, (_e, cardIds: string[], deckId: string) => ws.moveCards(cardIds, deckId))
  ipcMain.handle(IPC.resetProgress, (_e, cardIds: string[]) => ws.resetProgress(cardIds))
  ipcMain.handle(IPC.addCards, (_e, deckId: string, items: { front: string; back: string }[]) =>
    ws.addCards(deckId, items)
  )
  ipcMain.handle(IPC.updateCards, (_e, items: { cardId: string; front?: string; back?: string }[]) =>
    ws.updateCards(items)
  )
  ipcMain.handle(IPC.deleteCards, (_e, cardIds: string[]) => ws.deleteCards(cardIds))
  ipcMain.handle(IPC.getCards, (_e, cardIds: string[]) => ws.getCards(cardIds))
  ipcMain.handle(IPC.previewIntervals, (_e, cardId: string) => ws.previewIntervals(cardId))

  createWindow()
  setupCardDialogManager()

  app.on('will-quit', () => apiServer?.close())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // 主窗口关闭：先关弹窗子窗口（child 不阻止 window-all-closed 判定，但显式关保证 close 落盘）
  win?.on('closed', () => {
    dialogManager?.close()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

// ---------- 未捕获异常兜底 ----------
//
// 主进程原先没有任何 handler：一次未捕获异常（定时器回调、监听器、启动链）会让整个 app
// 直接消失。打包后没有终端，用户看不到任何输出——只能看到「应用自己退了」，无从排查。
// 这里把异常落盘到工作区的 miki-error.log 并弹一次可见提示，然后继续运行：
// 单机工具的一个后台任务失败不该带走整个应用（用户可能正在录卡）。
let fatalReported = false
/** 兜底自身出错时的递归防护：任一步骤抛错都不能让 handler 再抛 */
let inFatalHandler = false

function reportFatal(kind: string, err: unknown): void {
  if (inFatalHandler) return
  inFatalHandler = true
  try {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    const line = `[${new Date().toISOString()}] ${kind}\n${detail}\n\n`
    // 落盘优先：工作区未就绪时退回 userData
    const roots = [ws?.root, app.getPath('userData')].filter((p): p is string => !!p)
    for (const root of roots) {
      try {
        fs.appendFileSync(path.join(root, 'miki-error.log'), line, 'utf-8')
        break
      } catch {
        // 该目录不可写就试下一个
      }
    }
    console.error(`[miki] ${kind}:`, detail) // 开发期终端可见
    if (!fatalReported) {
      fatalReported = true // 只弹一次：连发异常不该刷屏
      const owner = win && !win.isDestroyed() ? win : null
      const opts = {
        type: 'warning' as const,
        title: 'Miki 遇到错误',
        message: kind,
        detail: `应用会继续运行。详细信息已写入工作区的 miki-error.log。\n\n${detail.slice(0, 800)}`
      }
      const p = owner ? dialog.showMessageBox(owner, opts) : dialog.showMessageBox(opts)
      void p.catch(() => {}) // 对话框失败不能再抛（否则又回到未捕获）
    }
  } catch {
    // 兜底失败：静默——此时已无处可报，但绝不能因此再抛
  } finally {
    inFatalHandler = false
  }
}

process.on('uncaughtException', (err) => reportFatal('未捕获异常', err))
process.on('unhandledRejection', (reason) => reportFatal('未处理的 Promise 拒绝', reason))
