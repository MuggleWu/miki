// 学习页（S 域）：空格流、1-4 评级、A/E/cmd+D/B/cmd+z
import { useCallback, useEffect, useRef, useState } from 'react'
import { Md } from '../md'
import { isTypingTarget, useApp } from '../store'
import type { Rating, StudyPayload } from '../../../shared/types'

const RATING_LABEL: Record<Rating, string> = { 1: '重来', 2: '困难', 3: '良好', 4: '轻松' }

function fmtInterval(ms: number): string {
  const days = ms / 86_400_000
  if (days >= 1) return `${Math.floor(days)} 天`
  const mins = Math.floor(ms / 60_000)
  if (mins >= 60) return `${Math.floor(mins / 60)} 小时`
  return `${mins} 分钟`
}

export function Study() {
  const studyDeckId = useApp((s) => s.studyDeckId)
  const decks = useApp((s) => s.decks)
  const openBrowser = useApp((s) => s.openBrowser)
  const openDialog = useApp((s) => s.openDialog)
  const setStudyCurrentCardId = useApp((s) => s.setStudyCurrentCardId)

  const [payload, setPayload] = useState<StudyPayload | null>(null)
  const [phase, setPhase] = useState<'question' | 'answer'>('question')
  const questionShownAt = useRef<number>(Date.now())

  const deck = decks.find((d) => d.id === studyDeckId)

  const refresh = useCallback(
    async (id: string) => {
      const p = await window.miki.getStudy(id)
      setPayload(p)
      setPhase('question')
      questionShownAt.current = Date.now()
      setStudyCurrentCardId(p.card?.id ?? null)
    },
    [setStudyCurrentCardId]
  )

  useEffect(() => {
    if (studyDeckId) void refresh(studyDeckId)
  }, [studyDeckId, refresh])

  const answer = useCallback(
    async (rating: Rating) => {
      if (!payload?.card || !studyDeckId) return
      const durationMs = Date.now() - questionShownAt.current
      const p = await window.miki.answer(payload.card.id, rating, durationMs)
      setPayload(p)
      setPhase('question')
      questionShownAt.current = Date.now()
      setStudyCurrentCardId(p.card?.id ?? null)
    },
    [payload, studyDeckId, setStudyCurrentCardId]
  )

  const showAnswer = useCallback(() => {
    if (!payload?.card) return
    setPhase('answer')
  }, [payload])

  const deleteCurrent = useCallback(async () => {
    if (!payload?.card || !studyDeckId) return
    await window.miki.deleteCard(payload.card.id)
    await refresh(studyDeckId)
  }, [payload, studyDeckId, refresh])

  const undo = useCallback(async () => {
    if (!studyDeckId) return
    const r = await window.miki.undo()
    if (r.restoredCardId && r.card) {
      // 回到被恢复卡的提问态（需求 §7）
      setPayload({ card: r.card, remaining: r.remaining, todayCount: r.todayCount })
      setPhase('question')
      questionShownAt.current = Date.now()
      setStudyCurrentCardId(r.card.id)
    }
  }, [studyDeckId, setStudyCurrentCardId])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      if (e.metaKey || e.ctrlKey) {
        if (e.key.toLowerCase() === 'd') {
          e.preventDefault()
          void deleteCurrent()
        } else if (e.key.toLowerCase() === 'z') {
          e.preventDefault()
          void undo()
        }
        return
      }
      if (e.key === ' ') {
        e.preventDefault()
        if (phase === 'question') showAnswer()
        else void answer(3)
        return
      }
      if (phase === 'answer' && ['1', '2', '3', '4'].includes(e.key)) {
        void answer(Number(e.key) as Rating)
        return
      }
      if (e.key.toLowerCase() === 'e' && payload?.card) {
        openDialog({ mode: 'edit', deckId: payload.card.deckId, cardId: payload.card.id })
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [phase, answer, showAnswer, deleteCurrent, undo, payload, openDialog])

  const card = payload?.card
  const nextDueLabel =
    card?.fsrs && phase === 'answer' && card.fsrs.due > Date.now() ? fmtInterval(card.fsrs.due - Date.now()) : null

  return (
    <div className="study">
      <div className="study-head">
        <span>牌组：{deck?.name ?? '—'}</span>
        <span>
          队列剩余 {payload?.remaining ?? 0} · 今天已学 {payload?.todayCount ?? 0} 张
        </span>
      </div>

      {!card && (
        <div className="study-empty">
          <div style={{ fontSize: 40 }}>🎉</div>
          <div>该牌组今天没有要刷的卡</div>
          <div>
            今日已学 {payload?.todayCount ?? 0} 张 · 按 <kbd className="kbd">A</kbd> 添加新卡
          </div>
        </div>
      )}

      {card && (
        <>
          <div className="cardbox">
            <Md source={card.front} />
            {phase === 'answer' && (
              <>
                <div className="divider" />
                <Md source={card.back} />
              </>
            )}
          </div>

          {phase === 'question' && (
            <div className="ratebar">
              <button className="primary" onClick={showAnswer} style={{ minWidth: 220 }}>
                显示答案（<kbd className="kbd">空格</kbd>）
              </button>
            </div>
          )}

          {phase === 'answer' && (
            <div className="ratebar">
              {([1, 2, 3, 4] as Rating[]).map((r) => (
                <button key={r} className={`rate-${r} ${r === 3 ? 'primary' : ''}`} onClick={() => void answer(r)}>
                  {RATING_LABEL[r]}
                  <span className="hint">
                    <kbd className="kbd">{r}</kbd>
                  </span>
                </button>
              ))}
            </div>
          )}

          {phase === 'answer' && nextDueLabel && (
            <div style={{ textAlign: 'center', color: 'var(--text-dim)', marginTop: 10 }}>
              下次间隔约 {nextDueLabel}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'center', gap: 18, marginTop: 14, color: 'var(--text-dim)', fontSize: 12 }}>
            <span>
              <kbd className="kbd">A</kbd> 添加
            </span>
            <span>
              <kbd className="kbd">E</kbd> 编辑当前卡
            </span>
            <span>
              <kbd className="kbd">⌘D</kbd> 删除当前卡
            </span>
            <span>
              <kbd className="kbd">⌘Z</kbd> 撤销
            </span>
            <span
              style={{ cursor: 'pointer' }}
              onClick={() => openBrowser(studyDeckId, card?.id ?? null)}
            >
              <kbd className="kbd">B</kbd> 卡片库
            </span>
          </div>
        </>
      )}
    </div>
  )
}
