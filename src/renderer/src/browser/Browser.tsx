// 卡片库（B 域）：牌组树 + 多关键词搜索 + 可配置列 + rotate 排序 + 右侧编辑面板
// 布局：左栏宽 / 表格宽 / 列宽均可拖动并跨页保持；⌘F 聚焦搜索框
// 虚拟滚动（B6）：行是单行 nowrap，行高恒定，首帧后实测一次；只渲染可视窗口行，上下用 spacer tr 撑开
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Md } from '../md'
import { rotateSort } from '../../../core/query'
import { isTypingTarget, sortedDecks, useApp } from '../store'
import { ColResizer, VResizer, isDragResizing } from '../components/drag'
import { applyWrap, enterContinueList, tickSelection } from '../components/AddEditDialog'
import type { BrowserColumn, CardRow, SortKey } from '../../../shared/types'

const COLUMN_LABEL: Record<BrowserColumn, string> = {
  front: '正面',
  deckName: '牌组',
  state: '状态',
  due: '距现在',
  dueAbs: '到期时间',
  interval: '间隔',
  stability: '稳定性',
  difficulty: '难度',
  reps: '次数',
  lapses: '遗忘',
  createdAt: '创建时间',
  updatedAt: '修改时间'
}

const DEFAULT_COL_WIDTH: Record<BrowserColumn, number> = {
  front: 260,
  deckName: 120,
  state: 96,
  due: 110,
  dueAbs: 150,
  interval: 90,
  stability: 90,
  difficulty: 90,
  reps: 70,
  lapses: 70,
  createdAt: 150,
  updatedAt: 150
}

const ALL_COLUMNS = Object.keys(COLUMN_LABEL) as BrowserColumn[]

/** 行高估计值：首帧 spacer 用，渲染后用实测行高替换 */
const ROW_H_ESTIMATE = 33
/** 视口上下各多渲染的行数，滚动时不露白 */
const OVERSCAN = 8

const STATE_LABEL: Record<string, string> = { new: '未学习', learning: '学习中', review: '待复习' }

function fmtTime(ms: number | null): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function fmtDue(ms: number | null): string {
  if (!ms) return '—'
  const diff = ms - Date.now()
  if (diff <= 0) return '现在'
  const days = diff / 86_400_000
  if (days >= 1) return `${Math.ceil(days)} 天后`
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟后`
  return `${Math.ceil(diff / 3_600_000)} 小时后`
}

export function Browser() {
  const decks = useApp((s) => s.decks)
  const config = useApp((s) => s.config)
  const browserDeckId = useApp((s) => s.browserDeckId)
  const browserFocusCardId = useApp((s) => s.browserFocusCardId)
  const browserKeywords = useApp((s) => s.browserKeywords)
  const dataEpoch = useApp((s) => s.dataEpoch)
  const setBrowserKeywords = useApp((s) => s.setBrowserKeywords)
  const selectedId = useApp((s) => s.browserSelectedId)
  const setSelectedId = useApp((s) => s.setBrowserSelectedId)
  const sideWidth = useApp((s) => s.browserSideWidth)
  const setSideWidth = useApp((s) => s.setBrowserSideWidth)
  const gridWidth = useApp((s) => s.browserGridWidth)
  const setGridWidth = useApp((s) => s.setBrowserGridWidth)
  const colWidths = useApp((s) => s.browserColWidths)
  const setColWidth = useApp((s) => s.setBrowserColWidth)
  const openBrowser = useApp((s) => s.openBrowser)
  const reload = useApp((s) => s.reload)

  const keywords = browserKeywords
  const [debouncedKw, setDebouncedKw] = useState(browserKeywords)
  const [rows, setRows] = useState<CardRow[]>([])
  const [total, setTotal] = useState(0)
  const [columns, setColumns] = useState<BrowserColumn[]>(() => {
    // 老配置只有 due 列：在「距现在」后补「到期时间」，两个到期视图都可见
    const saved = config?.browser.columns
    if (!saved) return ['front', 'deckName', 'state', 'due', 'dueAbs', 'updatedAt']
    if (saved.includes('due') && !saved.includes('dueAbs')) {
      const next = [...saved]
      next.splice(next.indexOf('due') + 1, 0, 'dueAbs')
      return next
    }
    return saved
  })
  const [sort, setSort] = useState<SortKey[]>(config?.browser.sort ?? [{ col: 'updatedAt', asc: false }])
  const [colMenu, setColMenu] = useState<{ x: number; y: number } | null>(null)
  /** 行右键菜单：ids = 操作对象集合（单卡或多选），mode='move' 时列出目标牌组 */
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; ids: string[]; mode: 'root' | 'move' } | null>(null)
  /** 多选集合（cmd/ctrl+点击、shift 范围、⌘A）；主选中始终是 selectedId */
  const [selection, setSelection] = useState<string[]>([])
  const [editFront, setEditFront] = useState<string | null>(null)
  const [editBack, setEditBack] = useState<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const gridWrapRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(600)
  const [rowH, setRowH] = useState(ROW_H_ESTIMATE)

  // ⌘F：聚焦搜索框（光标到末尾）；⌘A：全选当前视图卡片（输入框聚焦时不拦）
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const k = e.key.toLowerCase()
      if (k === 'f') {
        e.preventDefault()
        const el = searchRef.current
        if (el) {
          el.focus()
          el.setSelectionRange(el.value.length, el.value.length)
        }
      } else if (k === 'a' && !isTypingTarget(e.target)) {
        e.preventDefault()
        setSelection(rows.map((r) => r.id))
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [rows])

  // 搜索防抖
  useEffect(() => {
    const t = setTimeout(() => setDebouncedKw(keywords), 250)
    return () => clearTimeout(t)
  }, [keywords])

  const query = useCallback(async () => {
    const kws = debouncedKw.split(/\s+/).filter(Boolean)
    const r = await window.miki.queryCards({ deckId: browserDeckId, keywords: kws, sort, limit: 100_000 })
    setRows(r.rows)
    setTotal(r.total)
  }, [browserDeckId, debouncedKw, sort])

  useEffect(() => {
    void query()
  }, [query, config, dataEpoch])

  // 60 秒重取当前视图：相对到期（「距现在」）随时间推移自动更新
  useEffect(() => {
    const t = setInterval(() => void query(), 60_000)
    return () => clearInterval(t)
  }, [query])

  // 查询条件变化回到顶部；60 秒定时刷新不在依赖里，不打断当前位置
  useEffect(() => {
    gridWrapRef.current?.scrollTo({ top: 0 })
    setScrollTop(0)
  }, [browserDeckId, debouncedKw, sort])

  // 容器高度（窗口缩放 / 拖动分栏）决定可视行数
  useEffect(() => {
    const el = gridWrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight))
    ro.observe(el)
    setViewportH(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  // 行高实测：td 单行 nowrap 行高恒定，首帧渲染后测一次真实值，替换估计值
  useEffect(() => {
    if (rows.length === 0) return
    const tr = gridWrapRef.current?.querySelector('tbody tr:not([data-spacer])')
    const h = tr?.getBoundingClientRect().height ?? 0
    if (h > 0 && Math.abs(h - rowH) > 0.5) setRowH(h)
  }, [rows, rowH])

  // 离开时选中态持久化（跨启动恢复）：左树牌组 + 内容区主选中卡
  useEffect(() => {
    void window.miki.saveConfig({
      browser: { selectedDeckId: browserDeckId, selectedCardId: selectedId }
    })
  }, [browserDeckId, selectedId])

  // 外部焦点定位（学习页 B 键）
  useEffect(() => {
    if (browserFocusCardId) {
      setSelectedId(browserFocusCardId)
      openBrowser(browserDeckId, null)
    }
  }, [browserFocusCardId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- 选中与多选 ----------

  const selectOne = (id: string) => {
    setSelectedId(id)
    setSelection([id])
  }

  const toggleSelect = (id: string) => {
    setSelection((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
    setSelectedId(id)
  }

  const rangeSelect = (id: string) => {
    const a = rows.findIndex((r) => r.id === selectedId)
    const b = rows.findIndex((r) => r.id === id)
    if (a < 0 || b < 0) {
      selectOne(id)
      return
    }
    const [lo, hi] = a < b ? [a, b] : [b, a]
    setSelection(rows.slice(lo, hi + 1).map((r) => r.id))
    setSelectedId(id)
  }

  const onRowClick = (e: React.MouseEvent, id: string) => {
    if (e.metaKey || e.ctrlKey) toggleSelect(id)
    else if (e.shiftKey) rangeSelect(id)
    else selectOne(id)
  }

  const onRowContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault()
    if (!selection.includes(id)) selectOne(id)
    setRowMenu({ x: e.clientX, y: e.clientY, ids: selection.includes(id) ? selection : [id], mode: 'root' })
  }

  /** 右键菜单动作：批量删除 / 重置进度 / 移动牌组，完成后清选中并刷新 */
  const menuAction = async (act: 'delete' | 'reset' | 'move', targetDeckId?: string) => {
    if (!rowMenu) return
    const ids = rowMenu.ids
    if (act === 'delete') await window.miki.deleteCards(ids)
    if (act === 'reset') await window.miki.resetProgress(ids)
    if (act === 'move' && targetDeckId) await window.miki.moveCards(ids, targetDeckId)
    setRowMenu(null)
    setSelection([])
    if (selectedId && ids.includes(selectedId)) setSelectedId(null)
    await query()
    await reload()
  }

  const selected = useMemo(() => rows.find((r) => r.id === selectedId) ?? null, [rows, selectedId])

  // 选中卡内容进编辑区
  useEffect(() => {
    if (selected) {
      setEditFront(selected.front)
      setEditBack(selected.back)
    } else {
      setEditFront(null)
      setEditBack(null)
    }
  }, [selected?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // 编辑自动保存（B5：debounce 800ms）
  const scheduleSave = useCallback(
    (front: string, back: string) => {
      if (!selected) return
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(async () => {
        await window.miki.updateCard(selected.id, { front, back })
        await query()
      }, 800)
    },
    [selected, query]
  )

  const onHeaderClick = (col: BrowserColumn) => {
    // 列宽拖动结束时浏览器在 th 上派发的 click 不算排序点击
    if (isDragResizing()) return
    const next = rotateSort(sort, col)
    setSort(next)
    void window.miki.saveBrowserConfig(columns, next)
  }

  const toggleColumn = (col: BrowserColumn) => {
    let next: BrowserColumn[]
    if (columns.includes(col)) {
      if (columns.length === 1) return
      next = columns.filter((c) => c !== col)
    } else {
      next = [...columns, col]
    }
    setColumns(next)
    void window.miki.saveBrowserConfig(next, sort)
  }

  const cell = (row: CardRow, col: BrowserColumn) => {
    switch (col) {
      case 'front':
        return row.front.replace(/\s+/g, ' ').slice(0, 80)
      case 'deckName':
        return row.deckName
      case 'state':
        return row.suspended ? '⏸ 已暂停' : STATE_LABEL[row.state] ?? row.state
      case 'due':
        return row.suspended ? '—' : fmtDue(row.due)
      case 'dueAbs':
        return row.suspended ? '—' : fmtTime(row.due)
      case 'interval':
        return row.intervalDays != null ? `${row.intervalDays} 天` : '—'
      case 'stability':
        return row.stability != null ? row.stability.toFixed(2) : '—'
      case 'difficulty':
        return row.difficulty != null ? row.difficulty.toFixed(2) : '—'
      case 'reps':
        return String(row.reps)
      case 'lapses':
        return String(row.lapses)
      case 'createdAt':
        return fmtTime(row.createdAt)
      case 'updatedAt':
        return fmtTime(row.updatedAt)
    }
  }

  // 虚拟滚动窗口：只渲染可视区 ± OVERSCAN 行
  const top = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN)
  const winCount = Math.ceil(viewportH / rowH) + OVERSCAN * 2
  const winRows = rows.slice(top, top + winCount)
  const topPad = top * rowH
  const bottomPad = Math.max(0, rows.length - (top + winCount)) * rowH
  const spacerTd = (h: number) => ({
    colSpan: columns.length,
    style: { height: h, padding: 0, border: 'none' as const }
  })

  return (
    <div
      className="browser"
      onClick={() => {
        setColMenu(null)
        setRowMenu(null)
      }}
      onContextMenu={(e) => {
        // 空白处右键只关菜单，不弹系统菜单
        if ((e.target as HTMLElement).closest('tr') == null) {
          e.preventDefault()
          setRowMenu(null)
        }
      }}
    >
      <div className="browser-side" style={{ width: sideWidth }}>
        <div
          className={`tree-item ${browserDeckId == null ? 'active' : ''}`}
          onClick={() => openBrowser(null)}
        >
          <span>全部牌组</span>
        </div>
        {sortedDecks(decks).map((d) => (
          <div key={d.id} className={`tree-item ${browserDeckId === d.id ? 'active' : ''}`} onClick={() => openBrowser(d.id)}>
            <span>{d.name}</span>
          </div>
        ))}
      </div>

      <VResizer width={sideWidth} onResize={setSideWidth} />

      <div className="browser-main">
        <div className="browser-toolbar">
          <input
            ref={searchRef}
            value={keywords}
            onChange={(e) => setBrowserKeywords(e.target.value)}
            placeholder="搜索：多个关键词空格分隔（AND）"
          />
          <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
            {total} 张{total > rows.length ? `（显示前 ${rows.length}）` : ''}
          </span>
        </div>

        <div className="browser-body">
          <div
            className="grid-wrap"
            ref={gridWrapRef}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            style={gridWidth != null ? { width: gridWidth, flex: '0 0 auto' } : undefined}
          >
            <table
              className="grid"
              style={{ tableLayout: 'fixed', width: columns.reduce((n, c) => n + (colWidths[c] ?? DEFAULT_COL_WIDTH[c]), 0), minWidth: '100%' }}
            >
              <colgroup>
                {columns.map((col) => (
                  <col key={col} style={{ width: colWidths[col] ?? DEFAULT_COL_WIDTH[col] }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {columns.map((col) => (
                    <th
                      key={col}
                      onClick={() => onHeaderClick(col)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        setColMenu({ x: e.clientX, y: e.clientY })
                      }}
                      title="点击排序 / 右键配置列 / 拖右缘调列宽"
                    >
                      {COLUMN_LABEL[col]}
                      {sort[0]?.col === col && (sort[0].asc ? ' ↑' : ' ↓')}
                      <ColResizer
                        width={colWidths[col] ?? DEFAULT_COL_WIDTH[col]}
                        onResize={(w) => setColWidth(col, w)}
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={columns.length} style={{ cursor: 'default', color: 'var(--text-dim)' }}>
                      没有卡片
                    </td>
                  </tr>
                )}
                {topPad > 0 && (
                  <tr data-spacer aria-hidden="true">
                    <td {...spacerTd(topPad)} />
                  </tr>
                )}
                {winRows.map((row) => (
                  <tr
                    key={row.id}
                    className={row.id === selectedId || selection.includes(row.id) ? 'selected' : undefined}
                    onClick={(e) => onRowClick(e, row.id)}
                    onContextMenu={(e) => onRowContextMenu(e, row.id)}
                  >
                    {columns.map((col) => (
                      <td key={col}>{cell(row, col)}</td>
                    ))}
                  </tr>
                ))}
                {bottomPad > 0 && (
                  <tr data-spacer aria-hidden="true">
                    <td {...spacerTd(bottomPad)} />
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <VResizer width={gridWidth ?? 420} onResize={setGridWidth} />

          <div className="editor">
            {!selected && <div className="editor-empty">选中一张卡查看 / 编辑</div>}
            {selected && editFront != null && editBack != null && (
              <>
                <div>
                  <div className="block-title">正面（自动保存）</div>
                  <div className="block">
                    <textarea
                      value={editFront}
                      onChange={(e) => { setEditFront(e.target.value); scheduleSave(e.target.value, editBack) }}
                      onKeyDown={(e) => {
                        if (e.key === '`' && !e.metaKey && !e.ctrlKey && !e.altKey) {
                          const el = e.target instanceof HTMLTextAreaElement ? e.target : null
                          if (el) {
                            e.preventDefault()
                            applyWrap(el, (v) => { setEditFront(v); scheduleSave(v, editBack) }, tickSelection)
                          }
                        }
                        if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.nativeEvent.isComposing) {
                          const el = e.target instanceof HTMLTextAreaElement ? e.target : null
                          if (el && applyWrap(el, (v) => { setEditFront(v); scheduleSave(v, editBack) }, enterContinueList)) {
                            e.preventDefault()
                          }
                        }
                      }}
                    />
                    <div className="preview">
                      <Md source={editFront} />
                    </div>
                  </div>
                </div>
                <div>
                  <div className="block-title">反面（自动保存）</div>
                  <div className="block">
                    <textarea
                      value={editBack}
                      onChange={(e) => { setEditBack(e.target.value); scheduleSave(editFront, e.target.value) }}
                      onKeyDown={(e) => {
                        if (e.key === '`' && !e.metaKey && !e.ctrlKey && !e.altKey) {
                          const el = e.target instanceof HTMLTextAreaElement ? e.target : null
                          if (el) {
                            e.preventDefault()
                            applyWrap(el, (v) => { setEditBack(v); scheduleSave(editFront, v) }, tickSelection)
                          }
                        }
                        if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.nativeEvent.isComposing) {
                          const el = e.target instanceof HTMLTextAreaElement ? e.target : null
                          if (el && applyWrap(el, (v) => { setEditBack(v); scheduleSave(editFront, v) }, enterContinueList)) {
                            e.preventDefault()
                          }
                        }
                      }}
                    />
                    <div className="preview">
                      <Md source={editBack} />
                    </div>
                  </div>
                </div>
                <div className="editor-meta">
                  <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                    {selected.deckName} ·{' '}
                    {selected.suspended ? '⏸ 已暂停（不计入调度）' : STATE_LABEL[selected.state]} · 修改时间{' '}
                    {fmtTime(selected.updatedAt)}
                  </span>
                  {selected.suspended && (
                    <button
                      onClick={() => {
                        void window.miki.setCardSuspended(selected.id, false).then(() => void query())
                      }}
                    >
                      解除暂停
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {colMenu && (
        <div className="colmenu" style={{ left: colMenu.x - 140, top: colMenu.y }} onClick={(e) => e.stopPropagation()}>
          {ALL_COLUMNS.map((col) => (
            <label key={col}>
              <input type="checkbox" checked={columns.includes(col)} onChange={() => toggleColumn(col)} />
              {COLUMN_LABEL[col]}
            </label>
          ))}
        </div>
      )}

      {rowMenu && (
        <div
          className="rowmenu"
          style={{ left: Math.max(8, rowMenu.x - 60), top: rowMenu.y + 4 }}
          onClick={(e) => e.stopPropagation()}
        >
          {rowMenu.mode === 'root' ? (
            <>
              <button onClick={() => setRowMenu({ ...rowMenu, mode: 'move' })}>
                修改所属牌组{rowMenu.ids.length > 1 ? `（${rowMenu.ids.length} 张）` : ''}
              </button>
              <button onClick={() => void menuAction('reset')}>重置进度{rowMenu.ids.length > 1 ? `（${rowMenu.ids.length} 张）` : ''}</button>
              <button className="danger" onClick={() => void menuAction('delete')}>
                删除{rowMenu.ids.length > 1 ? `（${rowMenu.ids.length} 张）` : ''}
              </button>
            </>
          ) : (
            <>
              {sortedDecks(decks).map((d) => (
                <button key={d.id} onClick={() => void menuAction('move', d.id)}>
                  {d.name}
                </button>
              ))}
              <button className="back" onClick={() => setRowMenu({ ...rowMenu, mode: 'root' })}>
                ← 返回
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
