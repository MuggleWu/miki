// 卡片库：顶部搜索 + 牌组筛选，列表显示「正面 + 状态 + 到期」，点行打开详情抽屉编辑。
//
// 移动端与桌面端的差异（有意的）：
// - 不做虚拟滚动。桌面端卡片库有 60s 深滚动重取与虚拟列表，是因为一屏能放 30 行、且要支持
//   键盘上下键浏览；手机上按"搜索 + 牌组筛选"找人比滚一屏更实际，列表按 limit 分页加载即可。
// - 排序固定「到期时间升序」，不提供排序按钮：手机屏幕放不下排序器，而默认口径就是用户在意的。
import { useEffect, useState } from 'react'
import { useApp } from '../store'
import { useWorkspace } from '../use-workspace'
import { Sheet } from '../components/Sheet'
import { CardEditForm } from '../forms/CardEditForm'
import { fmtDuePreview } from '@shared/format'
import type { CardRow, CardState } from '@shared/types'

const PAGE = 50

// 与桌面端 Browser.tsx 用同一套字样，两端看到的状态名必须一致
const STATE_LABEL: Record<CardState, string> = { new: '未学习', learning: '学习中', review: '待复习' }

export function LibraryPage(): JSX.Element {
  const ws = useWorkspace()
  const bump = useApp((s) => s.bump)
  const notify = useApp((s) => s.notify)
  const back = useApp((s) => s.back)

  const [input, setInput] = useState('')
  const [keywords, setKeywords] = useState<string[]>([])
  const [deckId, setDeckId] = useState<string | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const [openId, setOpenId] = useState<string | null>(null)

  const decks = ws.deckInfos()

  // 搜索用 300ms 防抖：每敲一个字就全库扫一遍没必要，而手机上"结果边打边变"反而晃眼
  useEffect(() => {
    const t = setTimeout(() => {
      setKeywords(input.trim() ? input.trim().split(/\s+/) : [])
      setLimit(PAGE)
    }, 300)
    return () => clearTimeout(t)
  }, [input])

  // 直接算，不套 memo：useWorkspace() 订阅了写操作计数，任何答题/编辑/删除后的渲染
  // 都会得到新结果；而 memo 的依赖数组表达不了"工作区内部变了"，套上去只会拿到陈旧列表。
  // 代价是每次渲染扫一遍内存里的卡（limit 50 行输出），比维护失效逻辑便宜。
  // 输入框的抖动由 300ms 防抖吸收，不会每个字符扫一遍。
  const result = ws.queryCards({ deckId, keywords, sort: [{ col: 'due', asc: true }], limit })

  const openRow = openId ? (result.rows.find((r) => r.id === openId) ?? null) : null

  return (
    <>
      <div className="page-head">
        <button className="icon-btn" onClick={back} aria-label="返回">
          ‹
        </button>
        <h1>卡片库</h1>
        <span className="head-note">{result.total} 张</span>
      </div>

      <div className="filter-bar">
        <input
          className="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="搜索正面/背面"
          enterKeyHint="search"
        />
        <select
          value={deckId ?? ''}
          onChange={(e) => {
            setDeckId(e.target.value || null)
            setLimit(PAGE)
          }}
        >
          <option value="">全部牌组</option>
          {decks.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>

      <div className="page-body">
        {result.rows.length === 0 ? (
          <section className="empty">
            <p>{keywords.length > 0 ? '没有匹配的卡片。' : '这里还没有卡片。'}</p>
          </section>
        ) : (
          <ul className="card-list">
            {result.rows.map((r) => (
              <li key={r.id}>
                <button className="card-row" onClick={() => setOpenId(r.id)}>
                  <span className="row-front">{r.front}</span>
                  <span className="row-meta">
                    <span className={`st st${r.state}`}>{STATE_LABEL[r.state]}</span>
                    <span className="muted">{dueText(r)}</span>
                  </span>
                  <span className="row-deck muted">{r.deckName}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {result.rows.length < result.total ? (
          <button className="btn" onClick={() => setLimit((n) => n + PAGE)}>
            加载更多（已显示 {result.rows.length} / {result.total}）
          </button>
        ) : null}
      </div>

      <Sheet open={openRow !== null} title="卡片详情" onClose={() => setOpenId(null)}>
        {openRow ? (
          <CardDetail
            row={openRow}
            onChanged={() => {
              bump()
              setOpenId(null)
            }}
            onNotify={notify}
          />
        ) : null}
      </Sheet>
    </>
  )
}

function dueText(r: CardRow): string {
  if (r.state === 'new' || r.due === null) return '未学'
  return `到期 ${fmtDuePreview(r.due)}`
}

/** 详情抽屉：先看内容与调度参数，再决定编辑 / 暂停 / 删除 */
function CardDetail({
  row,
  onChanged,
  onNotify
}: {
  row: CardRow
  onChanged(): void
  onNotify(msg: string | null): void
}): JSX.Element {
  const ws = useWorkspace()
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)

  if (editing) {
    return (
      <CardEditForm
        cardId={row.id}
        onDone={(changed) => {
          setEditing(false)
          if (changed) onChanged()
        }}
      />
    )
  }

  async function act(fn: () => Promise<void>, msg: string): Promise<void> {
    setBusy(true)
    try {
      await fn()
      onNotify(msg)
      onChanged()
    } catch (e) {
      onNotify(`操作失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="detail-form">
      <div className="preview">
        <p className="preview-front">{row.front}</p>
        <hr className="sep" />
        <p className="preview-back">{row.back}</p>
      </div>
      <ul className="kv">
        <li>
          <span>牌组</span>
          <b>{row.deckName}</b>
        </li>
        <li>
          <span>状态</span>
          <b>{STATE_LABEL[row.state]}</b>
        </li>
        <li>
          <span>到期</span>
          <b>{row.due === null ? '—' : fmtDuePreview(row.due)}</b>
        </li>
        <li>
          <span>间隔</span>
          <b>{row.intervalDays === null ? '—' : `${row.intervalDays} 天`}</b>
        </li>
        <li>
          <span>复习次数 / 遗忘</span>
          <b>
            {row.reps} / {row.lapses}
          </b>
        </li>
      </ul>
      <div className="row-btns">
        <button className="btn primary" onClick={() => setEditing(true)} disabled={busy}>
          编辑
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={() => void act(() => ws.setCardSuspended(row.id, true).then(() => undefined), '已暂停')}
        >
          暂停
        </button>
        <button className="btn danger" disabled={busy} onClick={() => void act(() => ws.deleteCard(row.id), '已删除')}>
          删除
        </button>
      </div>
    </div>
  )
}
