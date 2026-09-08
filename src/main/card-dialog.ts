// 卡片添加/编辑弹窗子窗口管理器：单实例、载荷校验/排队、开关可见性通知、位置防抖持久化。
// 不 import electron——窗口工厂/事件/发送全部依赖注入，单测用 stub 覆盖全链路；
// 真实接线在 index.ts（BrowserWindow 适配为 CardDialogWindowLike）
import { IPC } from '../shared/ipc'
import { dialogWindowBounds, payloadToDialog } from '../shared/card-dialog'
import type { DialogState } from '../shared/types'

export interface CardDialogBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 弹窗窗口抽象：真实环境 = electron BrowserWindow 的薄适配；测试 = stub */
export interface CardDialogWindowLike {
  show(): void
  focus(): void
  isMinimized(): boolean
  restore(): void
  close(): void
  isDestroyed(): boolean
  getBounds(): CardDialogBounds
  on(event: 'ready-to-show' | 'close' | 'closed' | 'move' | 'resize', cb: () => void): void
  send(channel: string, ...args: unknown[]): void
  loadURL(u: string): void
}

export interface CardDialogDeps {
  /** 创建弹窗窗口（真实环境里同时接好导航防护等 electron 侧配置） */
  createWindow(opts: { bounds: CardDialogBounds; title: string }): CardDialogWindowLike
  /** 主窗口 bounds；null = 主窗口不存在（退出中/未建），拒绝开窗 */
  getParentBounds(): CardDialogBounds | null
  /** 主窗口所在显示器的工作区（外接屏拔掉时钳回可见区域） */
  getWorkArea(parentBounds: CardDialogBounds): CardDialogBounds
  /** config 里上次持久化的弹窗位置/尺寸（可能缺失/损坏） */
  getSavedBounds(): { x: number | null; y: number | null; width: number; height: number } | null | undefined
  /** 弹窗窗口加载地址（dev http / 打包 file，均带 #card-dialog） */
  buildUrl(): string
  /** 向主窗口发事件（visibility / cardsChanged） */
  notifyMainWindow(channel: string, ...args: unknown[]): void
  /** 位置/尺寸落盘（真实环境 = ws.saveConfig({ cardDialogWindow })） */
  saveBounds(b: CardDialogBounds): void
  /** 位置防抖落盘间隔（真实 800ms；测试可调） */
  persistDelayMs?: number
}

/** 单例管理器：同一时间只允许一个添加/编辑弹窗；重复 open = 聚焦 + 切换载荷 */
export class CardDialogManager {
  private win: CardDialogWindowLike | null = null
  private payload: DialogState | null = null
  /** ready-to-show 前不 send（webContents 未挂监听会丢消息），载荷排队到显示时统一下发 */
  private shown = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private deps: CardDialogDeps) {}

  /** 请求开窗：载荷非法直接丢弃；主窗口不在（退出中）不开 */
  open(raw: unknown): void {
    const payload = payloadToDialog(raw)
    if (!payload) return
    if (this.win && !this.win.isDestroyed()) {
      this.payload = payload
      if (this.shown) {
        this.win.send(IPC.cardDialogPayload, payload)
        if (this.win.isMinimized()) this.win.restore()
        this.win.show()
        this.win.focus()
      }
      // 载入中：只更新排队载荷，ready-to-show 时统一发送
      return
    }
    const parent = this.deps.getParentBounds()
    if (!parent) return
    const bounds = dialogWindowBounds(this.deps.getSavedBounds(), parent, this.deps.getWorkArea(parent))
    const title = payload.mode === 'add' ? '添加卡片' : '编辑卡片'
    const w = this.deps.createWindow({ bounds, title })
    this.win = w
    this.payload = payload
    this.shown = false
    w.loadURL(this.deps.buildUrl())
    w.on('ready-to-show', () => {
      if (this.win !== w) return
      this.shown = true
      w.show()
      w.focus()
      // ready-to-show 时 payload 仍在（closed 会清空），非空断言成立
      w.send(IPC.cardDialogPayload, this.payload!)
    })
    w.on('move', () => this.schedulePersist(w))
    w.on('resize', () => this.schedulePersist(w))
    // close（销毁前）：防抖中的位置立即补存，closed 后 getBounds 已不可用
    w.on('close', () => {
      if (this.win !== w) return
      this.clearPersistTimer()
      this.deps.saveBounds(w.getBounds())
    })
    w.on('closed', () => {
      if (this.win === w) {
        this.win = null
        this.payload = null
        this.shown = false
      }
      this.deps.notifyMainWindow(IPC.cardDialogVisibility, false)
    })
    this.deps.notifyMainWindow(IPC.cardDialogVisibility, true)
  }

  /** 请求关窗（未开着时 no-op；主窗口 Esc / 弹窗内 Esc/取消/编辑提交共用） */
  close(): void {
    if (this.win && !this.win.isDestroyed()) this.win.close()
  }

  /** 弹窗提交后转发刷新事件给主窗口；kind 越界归一为 add */
  notifyCardsChanged(kind: unknown): void {
    this.deps.notifyMainWindow(IPC.cardsChanged, { kind: kind === 'edit' ? 'edit' : 'add' })
  }

  /** 工作区热加载（git pull / 他机写入）：弹窗窗口的牌组下拉需要跟着刷新 */
  relayWorkspaceChanged(): void {
    if (this.win && !this.win.isDestroyed()) this.win.send(IPC.workspaceChanged)
  }

  private schedulePersist(w: CardDialogWindowLike): void {
    this.clearPersistTimer()
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      if (!w.isDestroyed()) this.deps.saveBounds(w.getBounds())
    }, this.deps.persistDelayMs ?? 800)
  }

  private clearPersistTimer(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
  }
}
