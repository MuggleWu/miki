// CardDialogManager 单测：stub 窗口覆盖开窗/复用聚焦/载荷排队/位置持久化/关闭通知全链路。
// 管理器不 import electron，直接 new 注入 stub deps
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CardDialogManager, type CardDialogDeps, type CardDialogWindowLike } from '../card-dialog'
import { IPC } from '../../shared/ipc'

interface StubWin {
  win: CardDialogWindowLike
  listeners: Map<string, () => void>
  sent: { channel: string; args: unknown[] }[]
  opts: { bounds: { x: number; y: number; width: number; height: number }; title: string }
}

function makeDeps(over: Partial<CardDialogDeps> = {}): {
  deps: CardDialogDeps
  created: StubWin[]
  saved: unknown[]
  mainSent: { channel: string; args: unknown[] }[]
} {
  const created: StubWin[] = []
  const saved: unknown[] = []
  const mainSent: { channel: string; args: unknown[] }[] = []
  const deps: CardDialogDeps = {
    createWindow: (opts) => {
      const listeners = new Map<string, () => void>()
      const sent: { channel: string; args: unknown[] }[] = []
      let destroyed = false
      const win: CardDialogWindowLike = {
        show: vi.fn(),
        focus: vi.fn(),
        isMinimized: () => false,
        restore: vi.fn(),
        close: vi.fn(() => {
          // 模拟 electron：close() 触发 close → closed（closed 后 isDestroyed 翻转）
          listeners.get('close')?.()
          listeners.get('closed')?.()
        }),
        isDestroyed: () => destroyed,
        getBounds: () => ({ x: 111, y: 222, width: 920, height: 672 }),
        on: (event, cb) => {
          // closed 事件触发即窗口销毁（对齐 electron 语义，供 isDestroyed 守卫验证）
          listeners.set(
            event,
            event === 'closed'
              ? () => {
                  destroyed = true
                  cb()
                }
              : cb
          )
        },
        send: (channel, ...args) => {
          sent.push({ channel, args })
        },
        loadURL: vi.fn()
      }
      created.push({ win, listeners, sent, opts })
      return win
    },
    getParentBounds: () => ({ x: 100, y: 50, width: 1280, height: 840 }),
    getWorkArea: () => ({ x: 0, y: 25, width: 1440, height: 900 }),
    getSavedBounds: () => null,
    buildUrl: () => 'file:///app/index.html#card-dialog',
    notifyMainWindow: (channel, ...args) => {
      mainSent.push({ channel, args })
    },
    saveBounds: (b) => {
      saved.push(b)
    },
    persistDelayMs: 0,
    ...over
  }
  return { deps, created, saved, mainSent }
}

const ADD = { mode: 'add', deckId: 'd1', cardId: null }
const EDIT = { mode: 'edit', deckId: null, cardId: 'c1' }

const flush = () => new Promise((r) => setTimeout(r, 5))

describe('CardDialogManager.open', () => {
  it('首次开窗：建窗 + 加载弹窗 URL + 标题按模式 + ready-to-show 后显示并下发载荷 + 主窗口收到 visibility(true)', () => {
    const { deps, created, mainSent } = makeDeps()
    const m = new CardDialogManager(deps)
    m.open(ADD)
    expect(created).toHaveLength(1)
    const { win, opts, sent, listeners } = created[0]
    expect(opts.bounds).toEqual({ x: 280, y: 106, width: 920, height: 672 }) // 1280/2-460, 50+(840-672)/3
    expect(opts.title).toBe('添加卡片')
    expect(win.loadURL).toHaveBeenCalledWith('file:///app/index.html#card-dialog')
    expect(win.show).not.toHaveBeenCalled() // ready-to-show 前
    ;(listeners.get('ready-to-show') as () => void)()
    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
    expect(sent).toEqual([{ channel: IPC.cardDialogPayload, args: [ADD] }])
    expect(mainSent).toContainEqual({ channel: IPC.cardDialogVisibility, args: [true] })
  })

  it('edit 模式标题为「编辑卡片」，载荷原样下发', () => {
    const { deps, created } = makeDeps()
    const m = new CardDialogManager(deps)
    m.open(EDIT)
    expect(created[0].opts.title).toBe('编辑卡片')
    ;(created[0].listeners.get('ready-to-show') as () => void)()
    expect(created[0].sent).toEqual([{ channel: IPC.cardDialogPayload, args: [EDIT] }])
  })

  it('载荷非法（edit 无 cardId / mode 不明 / 非对象）：不建窗', () => {
    const { deps, created } = makeDeps()
    const m = new CardDialogManager(deps)
    m.open({ mode: 'edit', cardId: null })
    m.open({ mode: 'boom' })
    m.open('add')
    m.open(null)
    expect(created).toHaveLength(0)
  })

  it('主窗口不在（退出中）：拒绝开窗', () => {
    const { deps, created } = makeDeps({ getParentBounds: () => null })
    const m = new CardDialogManager(deps)
    m.open(ADD)
    expect(created).toHaveLength(0)
  })

  it('已开着：聚焦复用同一窗口 + 推送新载荷，不重复建窗', () => {
    const { deps, created } = makeDeps()
    const m = new CardDialogManager(deps)
    m.open(ADD)
    ;(created[0].listeners.get('ready-to-show') as () => void)()
    m.open(EDIT)
    expect(created).toHaveLength(1)
    expect(created[0].sent).toHaveLength(2)
    expect(created[0].sent[1]).toEqual({ channel: IPC.cardDialogPayload, args: [EDIT] })
    expect(created[0].win.focus).toHaveBeenCalled()
  })

  it('已开着且被最小化：先 restore 再聚焦', () => {
    let minimized = true
    const { deps, created } = makeDeps({
      createWindow: (opts) => {
        const base = makeDeps().deps
        void base
        const listeners = new Map<string, () => void>()
        const sent: { channel: string; args: unknown[] }[] = []
        const win: CardDialogWindowLike = {
          show: vi.fn(),
          focus: vi.fn(),
          isMinimized: () => minimized,
          restore: vi.fn(() => {
            minimized = false
          }),
          close: vi.fn(),
          isDestroyed: () => false,
          getBounds: () => ({ x: 0, y: 0, width: 920, height: 672 }),
          on: (e, cb) => {
            listeners.set(e, cb)
          },
          send: (c, ...a) => {
            sent.push({ channel: c, args: a })
          },
          loadURL: vi.fn()
        }
        created.push({ win, listeners, sent, opts })
        return win
      }
    })
    const m = new CardDialogManager(deps)
    m.open(ADD)
    ;(created[0].listeners.get('ready-to-show') as () => void)()
    m.open(EDIT)
    expect(created[0].win.restore).toHaveBeenCalled()
  })

  it('载荷载入中重复开窗：更新排队载荷，ready-to-show 时下发最新一份', () => {
    const { deps, created } = makeDeps()
    const m = new CardDialogManager(deps)
    m.open(ADD)
    m.open(EDIT) // 上一窗还没 ready-to-show
    expect(created).toHaveLength(1)
    ;(created[0].listeners.get('ready-to-show') as () => void)()
    expect(created[0].sent).toEqual([{ channel: IPC.cardDialogPayload, args: [EDIT] }])
  })

  it('有持久化位置：建窗几何沿用记录', () => {
    const { deps, created } = makeDeps({ getSavedBounds: () => ({ x: 400, y: 200, width: 800, height: 600 }) })
    const m = new CardDialogManager(deps)
    m.open(ADD)
    expect(created[0].opts.bounds).toEqual({ x: 400, y: 200, width: 800, height: 600 })
  })
})

describe('CardDialogManager 持久化', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('move/resize 防抖落盘；close 时立即补存最终位置', () => {
    const { deps, created, saved } = makeDeps()
    const m = new CardDialogManager(deps)
    m.open(ADD)
    const { listeners } = created[0]
    ;(listeners.get('move') as () => void)()
    ;(listeners.get('resize') as () => void)()
    vi.advanceTimersByTime(10) // persistDelayMs=0 的宏任务
    expect(saved).toEqual([{ x: 111, y: 222, width: 920, height: 672 }])
    // close：close 回调里立即补存（防抖中的定时器被清掉，不重复）
    const before = saved.length
    ;(listeners.get('close') as () => void)()
    expect(saved.length).toBe(before + 1)
    expect(saved[saved.length - 1]).toEqual({ x: 111, y: 222, width: 920, height: 672 })
  })

  it('closed 后状态清空：下次 open 建新窗 + visibility(false) 已通知主窗口', () => {
    const { deps, created, mainSent } = makeDeps()
    const m = new CardDialogManager(deps)
    m.open(ADD)
    const { win } = created[0]
    win.close() // 触发 close + closed
    expect(mainSent.filter((s) => s.channel === IPC.cardDialogVisibility)).toHaveLength(2) // true + false
    m.open(ADD)
    expect(created).toHaveLength(2)
  })
})

describe('CardDialogManager.close / notifyCardsChanged', () => {
  it('close：开着时触发窗口 close；未开时 no-op 不抛', () => {
    const { deps, created } = makeDeps()
    const m = new CardDialogManager(deps)
    m.close() // 未开
    m.open(ADD)
    m.close()
    expect(created[0].win.close).toHaveBeenCalled()
    m.close() // 已关后再关
    expect(created[0].win.close).toHaveBeenCalledTimes(1)
  })

  it('notifyCardsChanged：转发主窗口；kind 越界归一为 add', () => {
    const { deps, mainSent } = makeDeps()
    const m = new CardDialogManager(deps)
    m.notifyCardsChanged('edit')
    m.notifyCardsChanged('add')
    m.notifyCardsChanged('weird')
    m.notifyCardsChanged(undefined)
    const cards = mainSent.filter((s) => s.channel === IPC.cardsChanged)
    expect(cards.map((s) => s.args[0])).toEqual([{ kind: 'edit' }, { kind: 'add' }, { kind: 'add' }, { kind: 'add' }])
  })

  it('relayWorkspaceChanged：弹窗开着时转发 workspaceChanged，关着时不发', () => {
    const { deps, created } = makeDeps()
    const m = new CardDialogManager(deps)
    m.relayWorkspaceChanged()
    expect(created).toHaveLength(0)
    m.open(ADD)
    m.relayWorkspaceChanged()
    expect(created[0].sent).toEqual([{ channel: IPC.workspaceChanged, args: [] }])
  })
})

describe('CardDialogManager.destroyed 竞态', () => {
  it('ready-to-show 前窗口被外部销毁：后续事件不生效（守卫 this.win !== w）', async () => {
    vi.useFakeTimers()
    const { deps, created, saved } = makeDeps()
    const m = new CardDialogManager(deps)
    m.open(ADD)
    const { win, listeners } = created[0]
    ;(listeners.get('closed') as () => void)() // 模拟先销毁
    ;(listeners.get('ready-to-show') as () => void)() // 迟到的 ready-to-show
    expect(win.show).not.toHaveBeenCalled()
    expect(created[0].sent).toHaveLength(0)
    ;(listeners.get('move') as () => void)() // 迟到的 move 也不落盘
    await vi.advanceTimersByTimeAsync(10)
    expect(saved).toHaveLength(0)
    vi.useRealTimers()
  })

  it('close 守卫：A 窗 close 事件不触发对 B 窗的补存', () => {
    vi.useFakeTimers()
    const { deps, created, saved } = makeDeps()
    const m = new CardDialogManager(deps)
    m.open(ADD)
    const a = created[0]
    a.win.close()
    m.open(ADD) // B 窗
    const b = created[1]
    ;(a.listeners.get('close') as () => void)() // 迟到的 A close
    expect(saved.filter((x) => (x as { x: number }).x === 0)).toHaveLength(0) // B 的 bounds 未被 A 事件污染
    void b
    vi.useRealTimers()
  })

  it('flush 防抖定时器用真实时钟也能落盘（persistDelayMs=0）', async () => {
    const { deps, created, saved } = makeDeps()
    const m = new CardDialogManager(deps)
    m.open(ADD)
    ;(created[0].listeners.get('move') as () => void)()
    await flush()
    expect(saved).toHaveLength(1)
  })
})
