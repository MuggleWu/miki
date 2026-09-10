// 卡片库编辑自动保存单测：核心约束是「切卡/离开页面不丢编辑」。
// 原缺陷：待存计时只挂在 saveTimer.current 上，切到另一张卡时新卡的 onChange
// 会 clearTimeout 掉上一张卡的计时，那份编辑静默丢失（无提示）。
//
// 用真计时器 + 实等：防抖窗口只有 800ms，实等 ~950ms 即可，比 fake timers 与
// React effect 调度的组合稳定（fake timers 下计时器注册表与 React 内部调度对不上，
// 会出现「明明在途却永不触发」的假象）。组件依赖 React 调度与 DOM，需 jsdom。
// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Browser } from '../browser/Browser'
import { useApp } from '../store'
import type { CardRow, MikiConfig, QueryResult } from '../../../shared/types'

/** 生产防抖窗口 800ms；测试注入更短窗口以避免整套慢 4s+（实等仍需留余量） */
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
    onWorkspaceChanged: vi.fn(() => () => {}),
    onCardDialogVisibility: vi.fn(() => () => {}),
    onCardsChanged: vi.fn(() => () => {}),
    onCardDialogPayload: vi.fn(() => () => {})
  } as unknown as typeof miki
  ;(window as unknown as { miki: unknown }).miki = miki
}

/** 挂载并等首屏取数完成 */
async function mountBrowser() {
  await act(async () => {
    root.render(<Browser saveDebounceMs={DEBOUNCE_MS} />)
  })
  await act(async () => {
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 真实等待（推进真计时器），并给 React 机会刷新 effect */
async function wait(ms: number) {
  await act(async () => {
    await sleep(ms)
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
