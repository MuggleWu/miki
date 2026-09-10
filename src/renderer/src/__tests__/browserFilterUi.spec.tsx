// 卡片库过滤 UI 单测：把「状态/到期」下拉真正接到 IPC 上，不只测纯函数。
// 后端一直支持 state/dueBefore/dueAfter，这条链断在渲染层——测到 queryCards
// 的入参才算这条功能真的通了。
// 组件依赖 React 调度与 DOM，需 jsdom。
// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Browser } from '../browser/Browser'
import { useApp } from '../store'
import type { CardRow, MikiConfig, QueryResult } from '../../../shared/types'

function row(id: string): CardRow {
  return {
    id,
    deckId: 'deck-1',
    deckName: '牌组一',
    front: `正面 ${id}`,
    back: '反面',
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

const CONFIG = {
  theme: 'light',
  study: { fontFamily: '', fontSize: 16 },
  browser: { columns: ['front'], sort: [{ col: 'updatedAt', asc: false }] }
} as unknown as MikiConfig

let host: HTMLDivElement
let root: Root
let miki: {
  queryCards: ReturnType<typeof vi.fn>
  saveConfig: ReturnType<typeof vi.fn>
  updateCard: ReturnType<typeof vi.fn>
  [key: string]: ReturnType<typeof vi.fn>
}

function installApi() {
  miki = {
    queryCards: vi.fn(async (): Promise<QueryResult> => ({ rows: [row('a')], total: 1 })),
    saveConfig: vi.fn(async () => CONFIG),
    updateCard: vi.fn(async () => null),
    saveBrowserConfig: vi.fn(async () => undefined),
    onWorkspaceChanged: vi.fn(() => () => {}),
    onCardDialogVisibility: vi.fn(() => () => {}),
    onCardsChanged: vi.fn(() => () => {}),
    onCardDialogPayload: vi.fn(() => () => {})
  }
  ;(window as unknown as { miki: unknown }).miki = miki
}

async function mountBrowser() {
  await act(async () => {
    root.render(<Browser saveDebounceMs={60} />)
  })
  await act(async () => {
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })
}

/** 工具栏里的两个过滤下拉 */
function filterSelects(): HTMLSelectElement[] {
  return [...host.querySelectorAll('.browser-toolbar select')] as HTMLSelectElement[]
}

/** 用 React 受控 select 的方式改值 */
async function chooseFilter(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => {
    await Promise.resolve()
  })
}

/** 最近一次 queryCards 入参 */
function lastQuery() {
  const calls = miki.queryCards.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][0] as Record<string, unknown>
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
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
      { id: 'deck-1', name: '牌组一', order: 0, createdAt: 1, deletedAt: null, counts: { total: 1, new: 1, due: 0 } }
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

describe('卡片库过滤 UI → IPC', () => {
  it('默认不加过滤：state 与到期窗口都传 null', async () => {
    await mountBrowser()
    expect(lastQuery()).toMatchObject({ state: null, dueBefore: null, dueAfter: null })
  })

  it('选「已暂停」→ queryCards 收到 state=suspended（leech 难卡池可达）', async () => {
    await mountBrowser()
    await chooseFilter(filterSelects()[0], 'suspended')
    expect(lastQuery()).toMatchObject({ state: 'suspended' })
  })

  it('选「待复习」→ state=review', async () => {
    await mountBrowser()
    await chooseFilter(filterSelects()[0], 'review')
    expect(lastQuery()).toMatchObject({ state: 'review' })
  })

  it('选「已到期」→ 只以此刻为上界，不限下界', async () => {
    await mountBrowser()
    const before = Date.now()
    await chooseFilter(filterSelects()[1], 'due')
    const q = lastQuery()
    expect(q.dueAfter).toBeNull()
    expect(q.dueBefore as number).toBeGreaterThanOrEqual(before)
    expect(q.dueBefore as number).toBeLessThanOrEqual(Date.now())
  })

  it('选「今天到期」→ 窗口落在本地当日（零点 ≤ due ≤ 当日末）', async () => {
    await mountBrowser()
    const now = new Date()
    const startOfDay = new Date(now).setHours(0, 0, 0, 0)
    const endOfDay = new Date(now).setHours(23, 59, 59, 999)
    await chooseFilter(filterSelects()[1], 'today')
    expect(lastQuery()).toMatchObject({ dueAfter: startOfDay, dueBefore: endOfDay })
  })

  it('选「已逾期」→ 上界是今天零点', async () => {
    await mountBrowser()
    const startOfDay = new Date().setHours(0, 0, 0, 0)
    await chooseFilter(filterSelects()[1], 'overdue')
    expect(lastQuery()).toMatchObject({ dueBefore: startOfDay, dueAfter: null })
  })

  it('选「7 天内」→ 下界今天零点、上界今天末 +7 天', async () => {
    await mountBrowser()
    const startOfDay = new Date().setHours(0, 0, 0, 0)
    const endOfDay = new Date().setHours(23, 59, 59, 999)
    await chooseFilter(filterSelects()[1], 'days7')
    expect(lastQuery()).toMatchObject({ dueAfter: startOfDay, dueBefore: endOfDay + 7 * 86_400_000 })
  })

  it('过滤档改动落 config.browser（跨启动保留）', async () => {
    await mountBrowser()
    await chooseFilter(filterSelects()[0], 'suspended')
    expect(miki.saveConfig).toHaveBeenCalledWith({ browser: { stateFilter: 'suspended' } })
    await chooseFilter(filterSelects()[1], 'days30')
    expect(miki.saveConfig).toHaveBeenCalledWith({ browser: { dueFilter: 'days30' } })
  })

  it('两个过滤可叠加生效（状态 + 到期同时下传）', async () => {
    await mountBrowser()
    await chooseFilter(filterSelects()[0], 'review')
    await chooseFilter(filterSelects()[1], 'days3')
    expect(lastQuery()).toMatchObject({ state: 'review', dueAfter: expect.any(Number), dueBefore: expect.any(Number) })
  })

  it('有过滤时出现「清除过滤」，点它回到不限', async () => {
    await mountBrowser()
    expect(host.querySelector('.filter-clear')).toBeNull()
    await chooseFilter(filterSelects()[0], 'suspended')
    const clear = host.querySelector('.filter-clear')
    expect(clear).not.toBeNull()
    await act(async () => {
      clear!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(lastQuery()).toMatchObject({ state: null, dueBefore: null, dueAfter: null })
  })

  it('config 里的非法档位被归一，不会把空查询发给后端', async () => {
    // 故意写非法值模拟手改 config.json（类型上需绕开，正是要测运行时归一）
    const bogus = { ...CONFIG, browser: { ...CONFIG.browser, stateFilter: 'bogus', dueFilter: 'nope' } }
    useApp.setState({ config: bogus as unknown as MikiConfig })
    await mountBrowser()
    expect(filterSelects()[0].value).toBe('')
    expect(filterSelects()[1].value).toBe('any')
    expect(lastQuery()).toMatchObject({ state: null, dueBefore: null, dueAfter: null })
  })
})
