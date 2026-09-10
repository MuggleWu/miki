// 卡片库分页「接线」单测：滚到底预取到的追加页必须真的进 React 状态。
// 这是回归测试——曾经 onScroll 只调 paginator.onScroll()，追加结果落在 paginator 闭包里
// 没有回写 state 的路径：滚过首屏（400 行）后表格一片空白，要等 60 秒定时刷新才补上。
// paginate.spec.ts 只测纯模块（createPaginator），测不到这段接线，所以在此真实渲染 Browser。
// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Browser } from '../browser/Browser'
import { useApp } from '../store'
import type { CardRow, MikiConfig, QueryResult } from '../../../shared/types'

const PAGE = 400
const TOTAL = 900
/** 与 Browser.tsx 的 ROW_H_ESTIMATE 一致；只用于算「滚到底」的几何量 */
const ROW_H_ESTIMATE = 33

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

/** 按 offset/limit 切片返回，模拟后端真实分页 */
function page(offset: number, limit: number): CardRow[] {
  const ids: CardRow[] = []
  for (let i = offset; i < Math.min(offset + limit, TOTAL); i++) ids.push(row(`c${i}`))
  return ids
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
    queryCards: vi.fn(async (p: { offset?: number; limit?: number }): Promise<QueryResult> => {
      const offset = p.offset ?? 0
      const limit = p.limit ?? PAGE
      return { rows: page(offset, limit), total: TOTAL }
    }),
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

function gridWrap(): HTMLDivElement {
  const el = host.querySelector('.grid-wrap')
  expect(el).not.toBeNull()
  return el as HTMLDivElement
}

/** 工具栏的「N 张（显示前 M）」文案 */
function countText(): string {
  const spans = [...host.querySelectorAll('.browser-toolbar span')] as HTMLSpanElement[]
  const hit = spans.find((s) => s.textContent?.includes('张'))
  return hit?.textContent ?? ''
}

/** 滚到容器底部：clientHeight / scrollHeight 在 jsdom 恒为 0，必须显式给几何量才可能越过预取线。
 * 预取线 = loaded * rowH - AHEAD_PX，滚到底（scrollTop + clientHeight 覆盖 total*rowH）必定越线 */
async function scrollToBottom() {
  const el = gridWrap()
  Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })
  Object.defineProperty(el, 'scrollHeight', { value: TOTAL * ROW_H_ESTIMATE + 600, configurable: true })
  await act(async () => {
    el.scrollTop = TOTAL * ROW_H_ESTIMATE
    el.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  // 追加是 promise 链（fetch → 守卫 → then(syncFromPaginator)），多刷几轮微任务
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** 已发出的取数 offset 列表 */
function offsets(): number[] {
  return miki.queryCards.mock.calls.map((c) => (c[0] as { offset: number }).offset)
}

/** 追加页（offset > 0）的请求次数 */
function appendCalls(): number {
  return offsets().filter((o) => o > 0).length
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
      {
        id: 'deck-1',
        name: '牌组一',
        order: 0,
        createdAt: 1,
        deletedAt: null,
        counts: { total: TOTAL, new: TOTAL, due: 0 }
      }
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

describe('卡片库分页滚动预取 → React 状态', () => {
  it('首屏只取第一页（offset=0），工具栏标注「显示前 400」', async () => {
    await mountBrowser()
    expect(countText()).toBe(`${TOTAL} 张（显示前 ${PAGE}）`)
    // 挂载期两次刷新（query 依赖链 + 60s 定时器立即各跑一次），但都只取首页、不发追加页
    expect(appendCalls()).toBe(0)
    const first = miki.queryCards.mock.calls[0][0] as { offset: number; limit: number }
    expect(first).toMatchObject({ offset: 0, limit: PAGE })
    expect(countText()).not.toContain('显示前 800')
  })

  it('滚到底预取下一页：追加行进入视图，工具栏变为「显示前 800」', async () => {
    await mountBrowser()
    expect(appendCalls()).toBe(0)
    await scrollToBottom()

    // 关键断言一：追加请求发出（offset=400）
    expect(offsets()).toContain(PAGE)

    // 关键断言二：追加结果真的进了 React 状态（回归点——曾只落在 paginator 闭包里）
    expect(countText()).toBe(`${TOTAL} 张（显示前 ${PAGE * 2}）`)
  })

  it('多次滚动到底可继续追加，取完后不再发追加请求', async () => {
    await mountBrowser()
    await scrollToBottom()
    const afterFirst = appendCalls()
    expect(afterFirst).toBeGreaterThan(0)

    await scrollToBottom()
    expect(countText()).toBe(`${TOTAL} 张`) // 900 行全部加载：total == rows.length，不再带「显示前」
    const afterSecond = appendCalls()
    expect(afterSecond).toBeGreaterThan(afterFirst)

    // 已取完（loaded >= total）：再滚也不发追加请求
    await scrollToBottom()
    expect(appendCalls()).toBe(afterSecond)
  })

  it('未越过预取线时不预取（顶部小滚动不触发）', async () => {
    await mountBrowser()
    const el = gridWrap()
    Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })
    // 预取线 = loaded * ROW_H_ESTIMATE - 600 = 400*33-600 = 12600，这里远未到
    await act(async () => {
      el.scrollTop = 100
      el.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(appendCalls()).toBe(0)
    expect(countText()).toBe(`${TOTAL} 张（显示前 ${PAGE}）`)
  })

  it('追加页返回空数组时不崩、不虚增行数', async () => {
    await mountBrowser()
    // 第二次请求返回空页：loaded += 0，rows 不变 → 工具栏保持「显示前 400」
    miki.queryCards.mockImplementation(async (p: { offset?: number; limit?: number }): Promise<QueryResult> => ({
      rows: (p.offset ?? 0) === 0 ? page(0, PAGE) : [],
      total: TOTAL
    }))
    await scrollToBottom()
    expect(offsets()).toContain(PAGE)
    expect(countText()).toBe(`${TOTAL} 张（显示前 ${PAGE}）`)
  })
})
