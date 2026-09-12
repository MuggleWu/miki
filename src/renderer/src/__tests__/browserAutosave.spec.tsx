// 卡片库编辑自动保存单测：核心约束是「切卡/离开页面不丢编辑」。
// 原缺陷：待存计时只挂在 saveTimer.current 上，切到另一张卡时新卡的 onChange
// 会 clearTimeout 掉上一张卡的计时，那份编辑静默丢失（无提示）。
//
// 时序口径：假计时器 + 精确推进（vi.advanceTimersByTimeAsync 包在 act 里）。
// 早先用真计时器实等，问题有两层：① 全量并行跑（30+ 文件）时同样的等待会被拉长，
// 「防抖期内还没落盘」这类断言会提前看到保存 → 假失败；② 为躲开它把窗口从 60ms
// 放大到 300ms，只是把余量做大，机器再慢还会复发。现在窗口只在测试显式推进时才到期，
// 与机器快慢无关（页面里读 Date.now() 只影响到期窗口显示，与本组断言无关）。
// 组件依赖 React 调度与 DOM，需 jsdom。
// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Browser } from '../browser/Browser'
import { useApp } from '../store'
import type { CardRow, MikiConfig, QueryResult } from '../../../shared/types'

/** 生产防抖窗口 800ms；测试注入更短窗口，靠假计时器推进，不产生真实等待 */
const DEBOUNCE_MS = 60
const PAST_DEBOUNCE = 90

function row(id: string, front: string, back: string): CardRow {
  return {
    id,
    deckId: 'deck-1',
    deckName: '牌组一',
    front,
    back,
    state: 'new',
    due: null,
    intervalDays: null,
    stability: null,
    difficulty: null,
    reps: 0,
    lapses: 0,
    suspended: false,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null
  }
}

const ROWS = [row('card-a', '正面 A', '反面 A'), row('card-b', '正面 B', '反面 B')]

const CONFIG = {
  theme: 'light',
  study: { fontFamily: '', fontSize: 16 },
  browser: {
    columns: ['front', 'deckName', 'state', 'due', 'dueAbs', 'updatedAt'],
    sort: [{ col: 'updatedAt', asc: false }]
  }
} as unknown as MikiConfig

let host: HTMLDivElement
let root: Root
let miki: {
  queryCards: ReturnType<typeof vi.fn>
  updateCard: ReturnType<typeof vi.fn>
  saveConfig: ReturnType<typeof vi.fn>
  /** 订阅类 API 本用例不走，桩成 no-op 即可 */
  [key: string]: ReturnType<typeof vi.fn>
}

function installApi() {
  miki = {
    queryCards: vi.fn(async (): Promise<QueryResult> => ({ rows: ROWS, total: ROWS.length })),
    updateCard: vi.fn(async () => null),
    saveConfig: vi.fn(async () => CONFIG),
    flushPendingEdit: vi.fn(() => true),
    onWorkspaceChanged: vi.fn(() => () => {}),
    onCardDialogVisibility: vi.fn(() => () => {}),
    onCardsChanged: vi.fn(() => () => {}),
    onCardDialogPayload: vi.fn(() => () => {})
  } as unknown as typeof miki
  ;(window as unknown as { miki: unknown }).miki = miki
}

/** 挂载并等首屏取数完成 */
async function mountBrowser(debounceMs = DEBOUNCE_MS) {
  await act(async () => {
    root.render(<Browser saveDebounceMs={debounceMs} />)
  })
  await act(async () => {
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })
}

/**
 * 推进假计时器 ms 毫秒：到期回调在 act 内触发，并连带冲刷它们排出的 Promise 链
 * （advanceTimersByTimeAsync 会 await 每个回调）。窗口到没到只取决于这里的推进量。
 */
async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** 当前渲染出的表格行（虚拟滚动，行数不多时全在可视窗口内） */
function tableRows(): HTMLTableRowElement[] {
  return [...host.querySelectorAll('tbody tr')].filter((tr) => !tr.hasAttribute('data-spacer')) as HTMLTableRowElement[]
}

/** 行内文本命中的表格行 */
function rowFor(text: string): HTMLTableRowElement {
  const tr = tableRows().find((r) => r.textContent?.includes(text))
  if (!tr) throw new Error(`未找到包含「${text}」的行`)
  return tr
}

/** 右侧编辑面板的两个 textarea（正面、反面） */
function editors(): HTMLTextAreaElement[] {
  return [...host.querySelectorAll('.editor textarea')] as HTMLTextAreaElement[]
}

/** 按 React 受控输入的方式写入并派发 input 事件 */
function typeInto(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // 时钟交给测试：防抖窗口只在 wait() 推进时到期（见文件头说明）。
  // 不伪造 Date：组件渲染时要读真实日期算到期窗口，伪造它只会引入与断言无关的差异。
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  // jsdom 缺口：卡片库用到 scrollTo 与 ResizeObserver，两者 jsdom 都不实现
  Element.prototype.scrollTo = () => {}
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  installApi()
  useApp.setState({
    decks: [
      { id: 'deck-1', name: '牌组一', order: 0, createdAt: 1, deletedAt: null, counts: { total: 2, new: 2, due: 0 } }
    ],
    config: CONFIG,
    tab: 'browser',
    browserDeckId: null,
    browserSelectedId: null,
    browserFocusCardId: null,
    browserKeywords: '',
    browserRestored: true,
    browserColWidths: {},
    dataEpoch: 0,
    contentEpoch: 0
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  host.remove()
  vi.restoreAllMocks()
  // 卸载完成后再交还真时钟：否则卸载清理里排的计时会留在假时钟上不触发
  vi.useRealTimers()
})

/** 选中一行、在正面输入框打字，但不让防抖计满 */
async function selectAndEdit(label: string, text: string) {
  await click(rowFor(label))
  const [front] = editors()
  expect(front).toBeDefined()
  await act(async () => {
    typeInto(front, text)
  })
}

describe('卡片库编辑自动保存', () => {
  it('停满防抖窗口才落盘，写的是当前选中卡', async () => {
    await mountBrowser()
    await selectAndEdit('正面 A', 'A 改过')
    expect(miki.updateCard).not.toHaveBeenCalled() // 防抖期内不落盘

    await wait(PAST_DEBOUNCE)
    expect(miki.updateCard).toHaveBeenCalledTimes(1)
    expect(miki.updateCard).toHaveBeenCalledWith('card-a', { front: 'A 改过', back: '反面 A' })
  })

  // 本组核心回归：原实现下这条拿到 0 次调用（编辑静默丢失）
  it('切到另一张卡时，先把上一张卡未落盘的编辑写掉', async () => {
    await mountBrowser()
    await selectAndEdit('正面 A', 'A 的新内容')
    expect(miki.updateCard).not.toHaveBeenCalled()

    // 防抖未满就切到 card-b：新卡接手编辑区，旧卡的计时会被新卡的 onChange 清掉
    await click(rowFor('正面 B'))
    expect(miki.updateCard).toHaveBeenCalledTimes(1)
    expect(miki.updateCard).toHaveBeenCalledWith('card-a', { front: 'A 的新内容', back: '反面 A' })
  })

  it('切卡落盘后不会再被防抖补写一次', async () => {
    await mountBrowser()
    await selectAndEdit('正面 A', 'A 的新内容')
    await click(rowFor('正面 B'))

    await wait(PAST_DEBOUNCE)
    expect(miki.updateCard).toHaveBeenCalledTimes(1)
  })

  // 「串卡」的另一半（前半是上面那条：切卡前必须先落盘）。缓冲不跟着选中行走时，
  // 编辑区显示的是上一张卡的内容，在它上面打字会写进**新**选中的卡
  // （目标 id 取自选中行、内容取自旧缓冲）：静默写坏数据。
  it('切卡后编辑区换成新卡内容，在它上面打字不会把旧卡内容写进新卡', async () => {
    await mountBrowser()
    await click(rowFor('正面 A'))
    expect(editors()[0].value).toBe('正面 A')

    await click(rowFor('正面 B'))
    expect(editors()[0].value).toBe('正面 B')
    expect(editors()[1].value).toBe('反面 B')

    await act(async () => {
      typeInto(editors()[0], 'B 改过')
    })
    await wait(PAST_DEBOUNCE)
    expect(miki.updateCard).toHaveBeenCalledTimes(1)
    expect(miki.updateCard).toHaveBeenCalledWith('card-b', { front: 'B 改过', back: '反面 B' })
  })

  it('离开卡片库（卸载）时把未落盘的编辑写掉', async () => {
    await mountBrowser()
    await selectAndEdit('正面 A', '离开前的编辑')
    expect(miki.updateCard).not.toHaveBeenCalled()

    await act(async () => {
      root.unmount()
    })
    expect(miki.updateCard).toHaveBeenCalledTimes(1)
    expect(miki.updateCard).toHaveBeenCalledWith('card-a', { front: '离开前的编辑', back: '反面 A' })
  })

  // 关窗/退出路径：React 不会执行卸载清理（进程直接结束），所以走 beforeunload + 同步 IPC。
  // jsdom 里只有手动派发事件才能覆盖这条路径——上面那条 unmount 用例测不到它。
  it('窗口关闭（beforeunload）时把未落盘的编辑交给同步通道落盘', async () => {
    await mountBrowser()
    await selectAndEdit('正面 A', '关窗前的编辑')
    expect(miki.updateCard).not.toHaveBeenCalled()
    expect(miki.flushPendingEdit).not.toHaveBeenCalled()

    await act(async () => {
      window.dispatchEvent(new Event('beforeunload'))
    })
    expect(miki.flushPendingEdit).toHaveBeenCalledTimes(1)
    expect(miki.flushPendingEdit).toHaveBeenCalledWith('card-a', { front: '关窗前的编辑', back: '反面 A' })
    // 走了同步通道就不该再走异步通道（否则同一份内容写两次）
    expect(miki.updateCard).not.toHaveBeenCalled()
  })

  it('窗口关闭时没有在途编辑则不发起写（避免多余的同步 IPC）', async () => {
    await mountBrowser()
    await click(rowFor('正面 A'))
    await act(async () => {
      window.dispatchEvent(new Event('beforeunload'))
    })
    expect(miki.flushPendingEdit).not.toHaveBeenCalled()
  })

  it('窗口关闭落盘后，防抖计时不会再补写一次', async () => {
    await mountBrowser()
    await selectAndEdit('正面 A', '关窗前的编辑')
    await act(async () => {
      window.dispatchEvent(new Event('beforeunload'))
    })
    await wait(PAST_DEBOUNCE)
    expect(miki.flushPendingEdit).toHaveBeenCalledTimes(1)
    expect(miki.updateCard).not.toHaveBeenCalled()
  })

  it('卡被删除离场时也先落盘在途编辑，编辑不随行消失', async () => {
    await mountBrowser()
    await selectAndEdit('正面 A', '删除前的编辑')
    // 外部操作删掉这张卡，随后重查（等价于 query 后该行消失）
    miki.queryCards.mockResolvedValue({ rows: [ROWS[1]], total: 1 })
    await act(async () => {
      useApp.getState().bumpData()
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(miki.updateCard).toHaveBeenCalledTimes(1)
    expect(miki.updateCard).toHaveBeenCalledWith('card-a', { front: '删除前的编辑', back: '反面 A' })
  })

  it('连续打字只在停顿后落盘一次最终值', async () => {
    await mountBrowser()
    await click(rowFor('正面 A'))
    const [front] = editors()
    await act(async () => {
      typeInto(front, 'v1')
    })
    await wait(DEBOUNCE_MS / 2) // 未满窗口就再打字：应重置防抖
    await act(async () => {
      typeInto(editors()[0], 'v2')
    })
    await wait(DEBOUNCE_MS / 2)
    expect(miki.updateCard).not.toHaveBeenCalled() // 每次打字都重置了防抖
    await wait(PAST_DEBOUNCE)
    expect(miki.updateCard).toHaveBeenCalledTimes(1)
    expect(miki.updateCard).toHaveBeenCalledWith('card-a', { front: 'v2', back: '反面 A' })
  })

  it('没有在途编辑时切卡不产生多余写', async () => {
    await mountBrowser()
    await click(rowFor('正面 A'))
    await click(rowFor('正面 B'))
    await wait(PAST_DEBOUNCE)
    expect(miki.updateCard).not.toHaveBeenCalled()
  })
})

// 落盘失败必须可见：updateCard 返回 null = 卡已被删/不存在，那份内容根本没写进去。
// 原实现忽略返回值、无条件刷视图，用户看到的是「刚打的字自己弹回旧内容」——既不知道
// 没保存、也不知道为什么。默认桩就是返回 null，正好是这条失败路径。
describe('编辑落盘失败要报出来', () => {
  const errorText = () => host.querySelector('.editor-error')?.textContent ?? null

  it('卡已被删（updateCard 返回 null）：显示提示且不假装保存成功', async () => {
    await mountBrowser()
    await selectAndEdit('正面 A', '写不进去的内容')
    expect(errorText()).toBeNull() // 防抖期内还没有结果
    await wait(PAST_DEBOUNCE)
    expect(miki.updateCard).toHaveBeenCalledTimes(1)
    expect(errorText()).toContain('已被删除')
  })

  it('写成功时不显示提示', async () => {
    await mountBrowser()
    miki.updateCard.mockResolvedValue({ ...row('card-a', '写进去了', '反面 A') })
    await selectAndEdit('正面 A', '写进去了')
    await wait(PAST_DEBOUNCE)
    expect(miki.updateCard).toHaveBeenCalledTimes(1)
    expect(errorText()).toBeNull()
  })

  it('换一张卡后，上一张卡的失败提示不跟过来', async () => {
    await mountBrowser()
    await selectAndEdit('正面 A', '写不进去的内容')
    await wait(PAST_DEBOUNCE)
    expect(errorText()).toContain('已被删除')
    await click(rowFor('正面 B'))
    expect(errorText()).toBeNull()
  })

  it('IPC 抛错时也报出来（不静默）', async () => {
    await mountBrowser()
    miki.updateCard.mockRejectedValue(new Error('boom'))
    await selectAndEdit('正面 A', '写不进去的内容')
    await wait(PAST_DEBOUNCE)
    expect(errorText()).toContain('写入失败')
  })
})
