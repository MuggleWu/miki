// 卡片库分页取数状态机（从 Browser.tsx 收敛出的纯逻辑层，不依赖 React / DOM）。
// 三守卫保证「追加页与当前 rows 同参数、同代际、无缝隙」：
// - dataVer：发生过新查询/刷新即弃旧追加响应
// - viewSig：查询参数变了即弃旧追加响应
// - loaded 基点：追加基点被别的取数动过即弃（防双页重叠/缺口）
// 同视图刷新（60s 定时/操作后重查）取已加载前缀，保住滚动位置；条件变化只取首页。
import { createSeqGuard } from '../staleGuard'
import type { CardRow, QueryParams, QueryResult, QueryState, SortKey } from '../../../shared/types'

export interface PageQuery {
  deckId: string | null
  keywords: string[]
  sort: SortKey[]
  /** 以下过滤条件参与视图签名：变了就必须弃掉旧追加页（否则拼接出跨条件的错乱表格） */
  state?: QueryState | null
  dueBefore?: number | null
  dueAfter?: number | null
}

/** 取数函数由调用方注入（window.miki.queryCards），模块自身不碰 IPC */
export type Fetcher = (params: QueryParams) => Promise<QueryResult>

export interface Paginator {
  /** 当前已渲染行（内部状态只读快照） */
  readonly rows: CardRow[]
  /** 服务端命中总数（含未取页） */
  total: number
  /** 首屏 / 条件变化 / 定时刷新统一入口 */
  refresh(view: PageQuery): Promise<void>
  /** 增量追加下一页；并发中或已取完时 no-op。视图参数 = 最近一次 refresh 的参数 */
  loadMore(): Promise<void>
  /** 滚动近底部预取回调：返回 true 表示触发了预取 */
  onScroll(scrollTop: number, clientHeight: number, rowH: number): boolean
  /** 测试与组件同步内部游标 */
  loaded(): number
  /** 未决追加进行中 */
  loading(): boolean
}

export function createPaginator(fetcher: Fetcher, pageSize = 400, aheadPx = 600): Paginator {
  const seq = createSeqGuard()
  let rows: CardRow[] = []
  let total = 0
  let dataVer = 0
  let lastView: PageQuery | null = null
  let loadingMore = false
  let loaded = 0

  const sigOf = (v: PageQuery) =>
    `${v.deckId ?? ''}|${v.keywords.join('\u0001')}|${JSON.stringify(v.sort)}|${v.state ?? ''}|${v.dueBefore ?? ''}|${v.dueAfter ?? ''}`

  /** 视图条件 → 取数入参（首屏与追加页共用，避免两处漏字段） */
  const paramsOf = (v: PageQuery, offset: number, limit: number): QueryParams => ({
    deckId: v.deckId,
    keywords: v.keywords,
    sort: v.sort,
    state: v.state ?? null,
    dueBefore: v.dueBefore ?? null,
    dueAfter: v.dueAfter ?? null,
    offset,
    limit
  })

  const refresh = async (view: PageQuery) => {
    const s = seq.next()
    // 同视图刷新（sig 相同）：取已加载前缀保住滚动位置；条件变化：只取首页
    const sameView = lastView !== null && sigOf(view) === sigOf(lastView)
    lastView = view
    dataVer++
    const want = sameView ? Math.max(pageSize, loaded) : pageSize
    const r = await fetcher(paramsOf(view, 0, want))
    if (!seq.isLatest(s)) return
    loaded = r.rows.length
    rows = r.rows
    total = r.total
  }

  const loadMore = async () => {
    if (loadingMore || lastView === null || loaded >= total) return
    loadingMore = true
    try {
      const view = lastView
      const ver = dataVer
      const sig = sigOf(view)
      const offsetBase = loaded
      const r = await fetcher(paramsOf(view, offsetBase, pageSize))
      // 三守卫：响应期间发生过新查询 / 参数变化 / 基点移动 → 丢弃（不拼接、不覆盖）
      if (dataVer !== ver || sigOf(lastView) !== sig || loaded !== offsetBase) return
      loaded += r.rows.length
      rows = [...rows, ...r.rows]
      total = r.total
    } finally {
      loadingMore = false
    }
  }

  return {
    get rows() {
      return rows
    },
    get total() {
      return total
    },
    refresh,
    loadMore,
    onScroll(scrollTop, clientHeight, rowH) {
      const nearBottom = scrollTop + clientHeight >= loaded * rowH - aheadPx
      if (loaded < total && nearBottom) {
        void loadMore()
        return true
      }
      return false
    },
    loaded() {
      return loaded
    },
    loading() {
      return loadingMore
    }
  }
}
