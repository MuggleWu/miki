import { app, BrowserWindow, ipcMain, screen, shell } from 'electron'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { WorkspaceService } from './workspace'
import { startApiServer } from './api-server'
import { IPC } from '../shared/ipc'
import type { MikiConfig, QueryParams, Rating, SortKey, StatsParams, WindowState } from '../shared/types'

let ws: WorkspaceService
let win: BrowserWindow | null = null

function resolveWorkspace(): string {
  // 1) 环境变量（开发/多工作区切换） 2) userData 配置 3) 默认 ~/miki-base
  if (process.env.MIKI_WORKSPACE) return process.env.MIKI_WORKSPACE
  const cfgFile = path.join(app.getPath('userData'), 'workspace.json')
  try {
    const stored = JSON.parse(fs.readFileSync(cfgFile, 'utf-8')) as { workspacePath?: string }
    if (stored.workspacePath) return stored.workspacePath
  } catch {
    // 无配置
  }
  return path.join(app.getPath('home'), 'miki-base')
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
  const restored = clampToWorkArea(ws.config.window)
  win = new BrowserWindow({
    x: restored.x,
    y: restored.y,
    width: restored.width,
    height: restored.height,
    minWidth: 960,
    minHeight: 600,
    title: 'Miki',
    // 与主题一致的启动底色，避免加载闪烁
    backgroundColor: ws.config.theme === 'dark' ? '#101014' : '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  // 上次是最大化：先按普通尺寸建窗再最大化（resize 回调里 getNormalBounds 仍取普通态，不会污染尺寸）
  if (ws.config.window.maximized) win.maximize()

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
  ws.init(resolveWorkspace())

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
  ipcMain.handle(IPC.updateCard, (_e, cardId: string, front: string, back: string) => ws.updateCard(cardId, front, back))
  ipcMain.handle(IPC.getCard, (_e, cardId: string) => ws.getCard(cardId))
  ipcMain.handle(IPC.deleteCard, (_e, cardId: string) => ws.deleteCard(cardId))
  ipcMain.handle(IPC.queryCards, (_e, params: QueryParams) => ws.queryCards(params))
  ipcMain.handle(IPC.getStats, (_e, params: StatsParams) => ws.getStats(params))
  ipcMain.handle(IPC.saveBrowserConfig, (_e, columns: string[], sort: SortKey[]) => {
    ws.config.browser.columns = columns as MikiConfig['browser']['columns']
    ws.config.browser.sort = sort
    const file = path.join(ws.root, 'config.json')
    // config.json 含 API token，仅限当前用户
    fs.writeFileSync(file, JSON.stringify(ws.config, null, 2), { encoding: 'utf-8', mode: 0o600 })
  })
  ipcMain.handle(IPC.saveTheme, (_e, theme: 'light' | 'dark') => {
    ws.config.theme = theme
    const file = path.join(ws.root, 'config.json')
    fs.writeFileSync(file, JSON.stringify(ws.config, null, 2), { encoding: 'utf-8', mode: 0o600 })
  })
  ipcMain.handle(IPC.saveConfig, (_e, patch: Partial<MikiConfig>) => ws.saveConfig(patch))
  ipcMain.handle(IPC.setCardSuspended, (_e, cardId: string, suspended: boolean) =>
    ws.setCardSuspended(cardId, suspended)
  )
  ipcMain.handle(IPC.moveCards, (_e, cardIds: string[], deckId: string) => ws.moveCards(cardIds, deckId))
  ipcMain.handle(IPC.resetProgress, (_e, cardIds: string[]) => ws.resetProgress(cardIds))
  ipcMain.handle(IPC.addCards, (_e, deckId: string, items: { front: string; back: string }[]) =>
    ws.addCards(deckId, items)
  )
  ipcMain.handle(IPC.updateCards, (_e, items: { cardId: string; front: string; back: string }[]) =>
    ws.updateCards(items)
  )
  ipcMain.handle(IPC.deleteCards, (_e, cardIds: string[]) => ws.deleteCards(cardIds))
  ipcMain.handle(IPC.getCards, (_e, cardIds: string[]) => ws.getCards(cardIds))
  ipcMain.handle(IPC.previewIntervals, (_e, cardId: string) => ws.previewIntervals(cardId))

  createWindow()

  // 本机 HTTP API（面向人与 AI 的程序化接口），安全边界见 api-server.ts 与 docs/api.md
  const apiServer = startApiServer(ws)
  app.on('will-quit', () => apiServer?.close())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
