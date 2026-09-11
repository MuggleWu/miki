// 学习页：点按卡面显示答案 → 底部四档评级（带下次间隔预览）→ 立刻出下一张。
//
// 状态机在 StudySession 里（可单测），这里只负责画和转发事件。
// 桌面端的单字母快捷键体系整体取消，唯一保留的肌肉记忆是"点按显示答案"。
import { useMemo, useRef, useState } from 'react'
import { useApp } from '../store'
import { StudySession, type StudyState } from '@mobile/study-session'
import { Sheet } from '../components/Sheet'
import { CardEditForm } from '../forms/CardEditForm'
import { RATING_LABEL } from '@shared/format'
import type { Rating } from '@shared/types'

const RATING_CLASS: Record<Rating, string> = { 1: 'r1', 2: 'r2', 3: 'r3', 4: 'r4' }

export function StudyPage({ deckId }: { deckId: string }): JSX.Element {
  const ws = useApp((s) => s.ws)!
  const bump = useApp((s) => s.bump)
  const back = useApp((s) => s.back)
  const notify = useApp((s) => s.notify)

  // 会话跟牌组绑定：换牌组就重开一个
  const session = useMemo(() => new StudySession(ws, deckId), [ws, deckId])
  // 初始状态直接由 start() 给出；换牌组靠 App 里的 key={deckId} 重挂载整个页面
  // （在 effect 里 setState 属于「渲染后再纠正一次」，React 明确不建议）
  const [state, setState] = useState<StudyState>(() => session.start())
  const [menu, setMenu] = useState(false)
  const [editing, setEditing] = useState(false)
  const busy = useRef(false)

  const deckName = ws.deckNameOf(deckId)

  async function rate(rating: Rating): Promise<void> {
    if (busy.current) return
    busy.current = true
    try {
      setState(await session.rate(rating))
      bump()
    } catch (e) {
      notify(`答题失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      busy.current = false
    }
  }

  async function undo(): Promise<void> {
    if (busy.current) return
    busy.current = true
    try {
      setState(await session.undo())
      bump()
    } catch (e) {
      notify(`撤销失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      busy.current = false
    }
  }

  const card = state.card

  return (
    <>
      <div className="page-head">
        <button className="icon-btn" onClick={back} aria-label="返回">
          ‹
        </button>
        <h1 className="ellipsis">{deckName}</h1>
        <span className="head-note">剩 {state.remaining}</span>
        <button className="icon-btn" onClick={() => void undo()} disabled={state.undoable === 0} aria-label="撤销">
          ↺
        </button>
        <button className="icon-btn" onClick={() => setMenu(true)} aria-label="更多">
          ⋮
        </button>
      </div>

      {state.flash ? <p className="flash">{state.flash}</p> : null}

      <div className="page-body study-body">
        {card === null ? (
          <section className="empty">
            <p>这个牌组今天没有要学的了。</p>
            <p className="muted">今日已学 {state.todayCount} 次。</p>
          </section>
        ) : (
          <div className="card-face" onClick={() => setState(session.reveal())}>
            <div className="face front">{card.front}</div>
            {state.revealed ? (
              <>
                <hr className="sep" />
                <div className="face back">{card.back}</div>
              </>
            ) : (
              <p className="hint muted">点按显示答案</p>
            )}
          </div>
        )}
      </div>

      {card !== null && state.revealed && state.preview ? (
        <div className="rating-bar">
          {state.preview.map((p) => (
            <button key={p.rating} className={`rate-btn ${RATING_CLASS[p.rating]}`} onClick={() => void rate(p.rating)}>
              <span className="rate-label">{RATING_LABEL[p.rating]}</span>
              <span className="rate-due">{p.label}</span>
            </button>
          ))}
        </div>
      ) : null}

      <Sheet open={menu} title="这张卡" onClose={() => setMenu(false)}>
        <button
          className="sheet-item"
          disabled={card === null}
          onClick={() => {
            setMenu(false)
            setEditing(true)
          }}
        >
          编辑
        </button>
        <button
          className="sheet-item"
          disabled={card === null}
          onClick={() => {
            setMenu(false)
            void (async () => {
              if (!card) return
              const next = !card.suspended
              await ws.setCardSuspended(card.id, next)
              bump()
              notify(next ? '已暂停' : '已恢复')
              setState(session.start())
            })()
          }}
        >
          {card?.suspended ? '恢复学习' : '暂停这张卡'}
        </button>
        <button
          className="sheet-item danger"
          disabled={card === null}
          onClick={() => {
            setMenu(false)
            void (async () => {
              if (!card) return
              await ws.deleteCard(card.id)
              bump()
              notify('已删除（可用 ↺ 撤销）')
              setState(session.start())
            })()
          }}
        >
          删除
        </button>
      </Sheet>

      <Sheet open={editing} title="编辑卡片" onClose={() => setEditing(false)}>
        {card ? (
          <CardEditForm
            cardId={card.id}
            onDone={(changed) => {
              setEditing(false)
              if (changed) {
                bump()
                setState(session.refreshCard())
              }
            }}
          />
        ) : null}
      </Sheet>
    </>
  )
}
