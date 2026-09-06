// 卡片库（B 域）：牌组树 + 多关键词搜索 + 可配置列 + rotate 排序 + 右侧编辑面板
// 布局：左栏宽 / 表格宽 / 列宽均可拖动并跨页保持；⌘F 聚焦搜索框
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Md } from '../md'
import { rotateSort } from '../../../core/query'
import { useApp } from '../store'
import { ColResizer, VResizer } from '../components/drag'
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
  const [editFront, setEditFront] = useState<string | null>(null)
  const [editBack, setEditBack] = useState<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // ⌘F：聚焦搜索框，已有内容时光标移到末尾
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        const el = searchRef.current
        if (el) {
          el.focus()
          el.setSelectionRange(el.value.length, el.value.length)
        }
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  // 搜索防抖
  useEffect(() => {
    const t = setTimeout(() => setDebouncedKw(keywords), 250)
    return () => clearTimeout(t)
  }, [keywords])

  const query = useCallback(async () => {
    const kws = debouncedKw.split(/\s+/).filter(Boolean)
    const r = await window.miki.queryCards({ deckId: browserDeckId, keywords: kws, sort, limit: 2000 })
    setRows(r.rows)
    setTotal(r.total)
  }, [browserDeckId, debouncedKw, sort])

  useEffect(() => {
    void query()
  }, [query, config])

  // 外部焦点定位（学习页 B 键）
  useEffect(() => {
    if (browserFocusCardId) {
      setSelectedId(browserFocusCardId)
      openBrowser(browserDeckId, null)
    }
  }, [browserFocusCardId]) // eslint-disable-line react-hooks/exhaustive-deps

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
        await window.miki.updateCard(selected.id, front, back)
        await query()
      }, 800)
    },
    [selected, query]
  )

  const onHeaderClick = (col: BrowserColumn) => {
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

  return (
    <div className="browser" onClick={() => setColMenu(null)}>
      <div className="browser-side" style={{ width: sideWidth }}>
        <div
          className={`tree-item ${browserDeckId == null ? 'active' : ''}`}
          onClick={() => openBrowser(null)}
        >
          <span>全部牌组</span>
        </div>
        {decks.map((d) => (
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
                {rows.map((row) => (
                  <tr key={row.id} className={row.id === selectedId ? 'selected' : undefined} onClick={() => setSelectedId(row.id)}>
                    {columns.map((col) => (
                      <td key={col}>{cell(row, col)}</td>
                    ))}
                  </tr>
                ))}
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
                    <textarea value={editFront} onChange={(e) => { setEditFront(e.target.value); scheduleSave(e.target.value, editBack) }} />
                    <div className="preview">
                      <Md source={editFront} />
                    </div>
                  </div>
                </div>
                <div>
                  <div className="block-title">反面（自动保存）</div>
                  <div className="block">
                    <textarea value={editBack} onChange={(e) => { setEditBack(e.target.value); scheduleSave(editFront, e.target.value) }} />
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
    </div>
  )
}
