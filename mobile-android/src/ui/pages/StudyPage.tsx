// 学习页：点按卡面显示答案 → 底部四档评级（带下次间隔预览）→ 立刻出下一张。
//
// 状态机在 StudySession 里（可单测），这里只负责画和转发事件。
// 桌面端的单字母快捷键体系整体取消，唯一保留的肌肉记忆是"点按显示答案"。
import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../store'
import { StudySession, type StudyState } from '@mobile/study-session'
import { Sheet } from '../components/Sheet'
import { CardEditForm } from '../forms/CardEditForm'
import { AddCardForm } from '../forms/AddCardForm'
import { useLongPress } from '../use-long-press'
import { Md } from '../md'
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
  // 刷卡时被当前这张卡启发出来的新卡：不退回首页、也不离开这个牌组，就地新增
  const [adding, setAdding] = useState(false)
  const busy = useRef(false)

  // 工作区在页面之外被改过（同步拉取、回到前台重载）→ 手里这张卡是重载前的旧对象：
  // 卡面文案、可撤销数都会停在旧值上。刷新一次（不换卡，见 StudySession.refresh）。
  const version = useApp((s) => s.version)
  useEffect(() => {
    setState(session.refresh())
  }, [version, session])

  const deckName = ws.deckNameOf(deckId)

  // 刷卡字体跟随桌面端设置（config.json 的 study.fontFamily / study.fontSize，桌面端只把它
  // 作用在刷卡卡片上，这里保持一致）。fontFamily 为空 = 跟随系统，就是桌面端的默认状态。
  const studyFont = ws.config.study
  const cardStyle = {
    '--study-fs': `${studyFont.fontSize}px`,
    fontFamily: studyFont.fontFamily || undefined
  } as React.CSSProperties

  // 长按卡面 = 桌面端的 E（编辑）；抬手后那次 tap 要被吞掉，否则会顺带显示答案
  const longPress = useLongPress({ onLongPress: () => setEditing(true) })

  /*
   * 评级条是 position: fixed（不占布局），所以卡面要自己让出它的高度。
   * 只在显示答案后才有这条，所以用实测高度写进 --rating-h：字号档位调大、按钮变高也不会漏算。
   * 量的是"视口底到条顶"再扣掉安全区与页面内边距——那部分本来就不在卡面的可达区域内。
   */
  const barRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = barRef.current
    const root = document.documentElement
    if (!el) {
      root.style.removeProperty('--rating-h')
      return
    }
    const apply = (): void => {
      const insetBottom = Number.parseFloat(getComputedStyle(root).getPropertyValue('--inset-bottom')) || 0
      const reserve = Math.max(
        0,
        Math.round(window.innerHeight - el.getBoundingClientRect().top - insetBottom - 12 + 8)
      )
      root.style.setProperty('--rating-h', `${reserve}px`)
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => {
      ro.disconnect()
      root.style.removeProperty('--rating-h')
    }
  }, [state.revealed])

  function tapCard(): void {
    if (longPress.shouldSwallowClick()) return
    setState(session.reveal())
  }

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
          <div
            className="card-face"
            style={cardStyle}
            onClick={tapCard}
            onPointerDown={longPress.onPointerDown}
            onPointerMove={longPress.onPointerMove}
            onPointerUp={longPress.onPointerUp}
            onPointerCancel={longPress.onPointerCancel}
          >
            <Md source={card.front} className="face front" />
            {state.revealed ? (
              <>
                <hr className="sep" />
                <Md source={card.back} className="face back" />
              </>
            ) : (
              <p className="hint muted">点按显示答案 · 长按编辑</p>
            )}
          </div>
        )}
      </div>

      {card !== null && state.revealed && state.preview ? (
        <div className="rating-bar" ref={barRef}>
          {state.preview.map((p) => (
            <button key={p.rating} className={`rate-btn ${RATING_CLASS[p.rating]}`} onClick={() => void rate(p.rating)}>
              <span className="rate-label">{RATING_LABEL[p.rating]}</span>
              <span className="rate-due">{p.label}</span>
            </button>
          ))}
        </div>
      ) : null}

      <Sheet open={menu} title="这张卡" onClose={() => setMenu(false)}>
        {/*
          新增卡片排在编辑之前：它是这个菜单里唯一「不针对当前这张卡」的动作，
          且是刷卡被打断时最想干的事（由当前卡想到一张新卡）。默认牌组就是当前牌组——
          在哪个牌组刷卡，新卡就落哪个牌组，不必回首页再选一次。
        */}
        <button
          className="sheet-item"
          onClick={() => {
            setMenu(false)
            setAdding(true)
          }}
        >
          新增卡片
        </button>
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
              // 不弹二次确认：删卡是高频操作，每次确认太烦。顶部 ↺ 能撤销（答题与删除都可撤），
              // 提示条也明说了可以撤销——需要"再想一下"的场景由撤销兜底，而不是每次都拦一道。
              await ws.deleteCard(card.id)
              bump()
              notify('已删除（可用顶部的 ↺ 撤销）')
              setState(session.start())
            })()
          }}
        >
          删除
        </button>
      </Sheet>

      {/*
        只在打开时挂载表单：编辑内容与乐观锁基准都是「打开那一刻」的快照，一直挂着会在
        刷到下一张卡后仍显示上一张的内容（真机上就是这个表现）。关掉即卸载，也顺带让
        「取消」真的等于放弃草稿（冲突提示里让人「关掉后重新打开再编辑」，靠的就是这条）。
      */}
      <Sheet open={editing} title="编辑卡片" full onClose={() => setEditing(false)}>
        {editing && card ? (
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

      {/*
        新增卡片就地开：卡片是从当前牌组里长出来的，所以默认牌组传当前牌组。
        提交后不关抽屉（连续录入），要关就点关闭——语义与桌面端连续新增一致。
        没有牌组时表单自己会说"先去建牌组"（这条路径只在学习页可达，而学习页必然有牌组）。
      */}
      <Sheet open={adding} title="新增卡片" onClose={() => setAdding(false)}>
        {adding ? <AddCardForm defaultDeckId={deckId} onDone={() => setAdding(false)} /> : null}
      </Sheet>
    </>
  )
}
