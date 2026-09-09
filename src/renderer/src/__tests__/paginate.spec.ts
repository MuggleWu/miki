// 分页取数状态机单测：三守卫（dataVer/viewSig/loaded 基点）+ 同视图刷新 + 滚动预取边界
import { describe, expect, it, vi } from 'vitest'
import { createPaginator, type PageQuery } from '../browser/paginate'
import type { CardRow, QueryResult } from '../../../shared/types'

function mkRow(id: string): CardRow {
  return {
    id,
    deckId: 'd1',
    deckName: 'deck',
    front: `front ${id}`,
    back: '',
    state: 'new',
    due: null,
    intervalDays: null,
    stability: null,
    difficulty: null,
    reps: 0,
    lapses: 0,
    suspended: false,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null
  }
}

/** 受控 fetcher：resolve 由测试手动放行，可精确构造响应晚到/乱序场景 */
const VIEW: PageQuery = { deckId: 'd1', keywords: ['a'], sort: [{ col: 'updatedAt', asc: false }] }

describe('createPaginator（卡片库分页取数）', () => {
  it('首屏取 PAGE_SIZE；loadMore 按 offset 追加且拼在尾部', async () => {
    const f = vi.fn()
    f.mockResolvedValueOnce({ rows: Array.from({ length: 400 }, (_, i) => mkRow(`r${i}`)), total: 900 })
    f.mockResolvedValueOnce({ rows: Array.from({ length: 400 }, (_, i) => mkRow(`n${i}`)), total: 900 })
    const p = createPaginator(f)
    await p.refresh(VIEW)
    expect(p.rows.length).toBe(400)
    expect(p.total).toBe(900)
    expect(f).toHaveBeenCalledWith(expect.objectContaining({ offset: 0, limit: 400 }))

    await p.loadMore()
    expect(f).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 400, limit: 400 }))
    expect(p.rows.length).toBe(800)
    expect(p.rows[400].id).toBe('n0')
  })

  it('已取完（loaded >= total）时 loadMore 不再发请求', async () => {
    const f = vi.fn().mockResolvedValue({ rows: [mkRow('a')], total: 1 })
    const p = createPaginator(f)
    await p.refresh(VIEW)
    await p.loadMore()
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('追加期间重复 loadMore 是 no-op（loadingMore 防并发）', async () => {
    let release!: (r: QueryResult) => void
    const f = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve({ rows: Array.from({ length: 400 }, (_, i) => mkRow(`r${i}`)), total: 800 })
      )
      .mockImplementationOnce(
        () =>
          new Promise<QueryResult>((resolve) => {
            release = resolve
          })
      )
    const p = createPaginator(f)
    await p.refresh(VIEW)
    const second = p.loadMore()
    expect(p.loading()).toBe(true)
    await p.loadMore() // 在途中的重复调用应被拒绝
    expect(f).toHaveBeenCalledTimes(2)
    release({ rows: Array.from({ length: 400 }, (_, i) => mkRow(`n${i}`)), total: 800 })
    await second
    expect(p.rows.length).toBe(800)
    expect(p.loading()).toBe(false)
  })

  it('守卫一：追加响应期间发生过新 refresh（dataVer 变化）→ 追加整页丢弃', async () => {
    let releasePage2!: (r: QueryResult) => void
    const f = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve({ rows: Array.from({ length: 400 }, (_, i) => mkRow(`r${i}`)), total: 800 })
      )
      .mockImplementationOnce(
        () =>
          new Promise<QueryResult>((resolve) => {
            releasePage2 = resolve
          })
      )
    // 第二次 refresh（条件变化后首屏）
    f.mockImplementationOnce(() => Promise.resolve({ rows: [mkRow('x')], total: 1 }))
    const p = createPaginator(f)
    await p.refresh(VIEW)

    const appending = p.loadMore() // offset=400 的追加在途
    await p.refresh({ deckId: null, keywords: [], sort: [] }) // 用户改条件 → dataVer++
    releasePage2({ rows: Array.from({ length: 400 }, (_, i) => mkRow(`n${i}`)), total: 800 })
    await appending

    expect(p.rows.length).toBe(1) // 旧追加不覆盖新条件的结果
    expect(p.rows[0].id).toBe('x')
  })

  it('守卫二：追加响应期间视图参数变了（viewSig 变化）→ 追加丢弃', async () => {
    let releaseAppend!: (r: QueryResult) => void
    const f = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve({ rows: Array.from({ length: 400 }, (_, i) => mkRow(`r${i}`)), total: 800 })
      )
      .mockImplementationOnce(
        () =>
          new Promise<QueryResult>((resolve) => {
            releaseAppend = resolve
          })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({ rows: Array.from({ length: 400 }, (_, i) => mkRow(`b${i}`)), total: 400 })
      )
    const p = createPaginator(f)
    await p.refresh(VIEW)

    const appending = p.loadMore()
    await p.refresh({ ...VIEW, keywords: ['b'] }) // 参数变化 → 新视图首屏
    releaseAppend({ rows: [mkRow('late')], total: 800 })
    await appending
    // 新视图首屏 400 行（关键词 b 的首页），晚到的追加页没有混进来
    expect(p.rows.length).toBe(400)
    expect(p.rows.some((r) => r.id === 'late')).toBe(false)
  })

  it('守卫三：追加响应期间基点被别的取数动过（loaded 变化）→ 追加丢弃，防重叠/缺口', async () => {
    let releaseAppend!: (r: QueryResult) => void
    const f = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve({ rows: Array.from({ length: 400 }, (_, i) => mkRow(`r${i}`)), total: 1600 })
      )
      .mockImplementationOnce(
        () =>
          new Promise<QueryResult>((resolve) => {
            releaseAppend = resolve
          })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          rows: Array.from({ length: 400 }, (_, i) => mkRow(`r${i}`)),
          total: 1600
        })
      )
    const p = createPaginator(f)
    await p.refresh(VIEW)

    const appending = p.loadMore() // offset=400
    await p.refresh(VIEW) // 同视图刷新：取已加载前缀 400（第 3 次 fetch），基点仍 400
    releaseAppend({ rows: [mkRow('stale-page')], total: 1600 })
    await appending
    // 同视图刷新走了 want=max(400, loaded) 前缀路径，rows 仍是 400 行；晚到追加页不拼接
    expect(p.rows.length).toBe(400)
    expect(p.rows.some((r) => r.id === 'stale-page')).toBe(false)
  })

  it('同视图刷新（60s 定时/操作后重查）：limit 取已加载前缀，保住 800 行不被缩回 400', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce({ rows: Array.from({ length: 400 }, (_, i) => mkRow(`r${i}`)), total: 800 })
      .mockResolvedValueOnce({ rows: Array.from({ length: 400 }, (_, i) => mkRow(`n${i}`)), total: 800 })
      .mockResolvedValueOnce({
        rows: [
          ...Array.from({ length: 400 }, (_, i) => mkRow(`r${i}`)),
          ...Array.from({ length: 400 }, (_, i) => mkRow(`n${i}`))
        ],
        total: 800
      })
    const p = createPaginator(f)
    await p.refresh(VIEW)
    await p.loadMore()
    expect(p.rows.length).toBe(800)

    await p.refresh(VIEW) // 60s 定时刷新：同 sig
    expect(f).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0, limit: 800 }))
    expect(p.rows.length).toBe(800)
  })

  it('条件变化刷新只取首页，rows 缩回 PAGE_SIZE', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce({ rows: Array.from({ length: 400 }, (_, i) => mkRow(`r${i}`)), total: 800 })
      .mockResolvedValueOnce({ rows: Array.from({ length: 400 }, (_, i) => mkRow(`n${i}`)), total: 800 })
      .mockResolvedValueOnce({ rows: [mkRow('only')], total: 1 })
    const p = createPaginator(f)
    await p.refresh(VIEW)
    await p.loadMore()
    await p.refresh({ ...VIEW, keywords: ['new'] })
    expect(f).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0, limit: 400 }))
    expect(p.rows.length).toBe(1)
    expect(p.rows[0].id).toBe('only')
  })

  it('onScroll：越过预取线触发 loadMore，未越线或已取完不触发', async () => {
    const f = vi.fn().mockResolvedValue({ rows: Array.from({ length: 400 }, (_, i) => mkRow(`r${i}`)), total: 800 })
    const p = createPaginator(f, 400, 600)
    await p.refresh(VIEW)

    // rowH=33：已加载 400 行底缘 13200px。滚动位置 + 视口 < 13200-600 → 不取
    expect(p.onScroll(0, 600, 33)).toBe(false)
    // 越线 → 触发（loadMore 在途，返回 true）
    expect(p.onScroll(12650, 600, 33)).toBe(true)
    await p.loadMore()
  })
})
