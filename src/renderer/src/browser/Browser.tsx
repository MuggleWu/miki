// 卡片库（B 域）：牌组树 + 多关键词搜索 + 可配置列 + rotate 排序 + 右侧编辑面板
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Md } from '../md'
import { rotateSort } from '../../../core/query'
import { useApp } from '../store'
import type { BrowserColumn, CardRow, SortKey } from '../../../shared/types'

const COLUMN_LABEL: Record<BrowserColumn, string> = {
  front: '正面',
  deckName: '牌组',
  state: '状态',
  due: '到期',
  interval: '间隔',
  stability: '稳定性',
  difficulty: '难度',
  reps: '次数',
  lapses: '遗忘',
  createdAt: '创建时间',
  updatedAt: '修改时间'
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
  return `${Math.ceil(diff / 3_600_000)} 小时后`
}

export function Browser() {
  const decks = useApp((s) => s.decks)
  const config = useApp((s) => s.config)
  const browserDeckId = useApp((s) => s.browserDeckId)
  const browserFocusCardId = useApp((s) => s.browserFocusCardId)
  const openBrowser = useApp((s) => s.openBrowser)

  const [keywords, setKeywords] = useState('')
  const [debouncedKw, setDebouncedKw] = useState('')
  const [rows, setRows] = useState<CardRow[]>([])
  const [total, setTotal] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [columns, setColumns] = useState<BrowserColumn[]>(config?.browser.columns ?? ['front', 'deckName', 'state', 'due', 'updatedAt'])
  const [sort, setSort] = useState<SortKey[]>(config?.browser.sort ?? [{ col: 'updatedAt', asc: false }])
  const [colMenu, setColMenu] = useState<{ x: number; y: number } | null>(null)
  const [editFront, setEditFront] = useState<string | null>(null)
  const [editBack, setEditBack] = useState<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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
        return STATE_LABEL[row.state] ?? row.state
      case 'due':
        return fmtDue(row.due)
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
      <div className="browser-side">
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

      <div className="browser-main">
        <div className="browser-toolbar">
          <input
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="搜索：多个关键词空格分隔（AND）"
          />
          <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
            {total} 张{total > rows.length ? `（显示前 ${rows.length}）` : ''}
          </span>
        </div>

        <div className="browser-body">
          <div className="grid-wrap">
            <table className="grid">
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
                      title="点击排序 / 右键配置列"
                    >
                      {COLUMN_LABEL[col]}
                      {sort[0]?.col === col && (sort[0].asc ? ' ↑' : ' ↓')}
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

          <div className="editor">
            {!selected && <div className="editor-empty">选中一张卡查看 / 编辑</div>}
            {selected && editFront != null && editBack != null && (
              <>
                <div>
                  <div className="block-title">正面 · 左源码右预览（自动保存）</div>
                  <div className="block">
                    <textarea value={editFront} onChange={(e) => { setEditFront(e.target.value); scheduleSave(e.target.value, editBack) }} />
                    <div className="preview">
                      <Md source={editFront} />
                    </div>
                  </div>
                </div>
                <div>
                  <div className="block-title">反面 · 左源码右预览（自动保存）</div>
                  <div className="block">
                    <textarea value={editBack} onChange={(e) => { setEditBack(e.target.value); scheduleSave(editFront, e.target.value) }} />
                    <div className="preview">
                      <Md source={editBack} />
                    </div>
                  </div>
                </div>
                <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                  {selected.deckName} · {STATE_LABEL[selected.state]} · 修改时间 {fmtTime(selected.updatedAt)}
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
