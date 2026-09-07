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
  const config = useApp((s) => s.config)
  const contentEpoch = useApp((s) => s.contentEpoch)
  const dataEpoch = useApp((s) => s.dataEpoch)
  const openBrowser = useApp((s) => s.openBrowser)
  const openDialog = useApp((s) => s.openDialog)
  const setStudyCurrentCardId = useApp((s) => s.setStudyCurrentCardId)

  const [payload, setPayload] = useState<StudyPayload | null>(null)
  const [phase, setPhase] = useState<'question' | 'answer'>('question')
  const [previewDue, setPreviewDue] = useState<number[]>([])
  const questionShownAt = useRef<number>(Date.now())
  // 最近一次装载进界面的卡（编辑弹窗确认后的重取用它判断「同卡」→ 保留当前相位）
  const loadedCardIdRef = useRef<string | null>(null)

  const deck = decks.find((d) => d.id === studyDeckId)
  const font = config?.study

  const refresh = useCallback(
    async (id: string, keepPhase = false) => {
      const prevId = loadedCardIdRef.current
      const p = await window.miki.getStudy(id)
      if (!(keepPhase && p.card && p.card.id === prevId)) setPhase('question')
      setPayload(p)
      loadedCardIdRef.current = p.card?.id ?? null
      questionShownAt.current = Date.now()
      setStudyCurrentCardId(p.card?.id ?? null)
    },
    [setStudyCurrentCardId]
  )

  // 进入/换牌组重取；contentEpoch 变化（编辑当前卡确认后）也重取，同卡不清答题相位；
  // dataEpoch 变化（工作区热加载）同样重取：同卡保留相位，被外部删除/移走则换下一张
  useEffect(() => {
    if (studyDeckId) void refresh(studyDeckId, true)
  }, [studyDeckId, refresh, contentEpoch, dataEpoch])

  // 评级按钮的下次到期预览（不落盘）
  useEffect(() => {
    setPreviewDue([])
    if (payload?.card) {
      void window.miki.previewIntervals(payload.card.id).then(setPreviewDue)
    }
  }, [payload?.card?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const answer = useCallback(
    async (rating: Rating) => {
      if (!payload?.card || !studyDeckId) return
      const durationMs = Date.now() - questionShownAt.current
      const p = await window.miki.answer(payload.card.id, rating, durationMs)
      setPayload(p)
      loadedCardIdRef.current = p.card?.id ?? null
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
      loadedCardIdRef.current = r.card.id
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

  const fmtDuePreview = (due: number): string => {
    const diff = due - Date.now()
    if (diff <= 0) return '现在'
    if (diff / 86_400_000 >= 31) return `+${(diff / (30.44 * 86_400_000)).toFixed(1)} 个月`
    return `+${fmtInterval(diff)}`
  }

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
          <div className="cardbox" style={{ fontFamily: font?.fontFamily || undefined, fontSize: font?.fontSize || undefined }}>
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
              <button className="primary show-answer" onClick={showAnswer}>
                显示答案
              </button>
            </div>
          )}

          {phase === 'answer' && (
            <div className="ratebar">
              {([1, 2, 3, 4] as Rating[]).map((r) => (
                <button key={r} className={`rate-card rate-${r}`} onClick={() => void answer(r)}>
                  <span className="rate-top">
                    {RATING_LABEL[r]}
                    <kbd className="kbd">{r}</kbd>
                  </span>
                  <span className="rate-due">{previewDue[r - 1] ? fmtDuePreview(previewDue[r - 1]) : ' '}</span>
                </button>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'center', gap: 18, marginTop: 14, color: 'var(--text-dim)', fontSize: 12 }}>
            {phase === 'question' ? (
              <span>
                <kbd className="kbd">空格</kbd> 显示答案
              </span>
            ) : (
              <span>
                <kbd className="kbd">1</kbd>
                <kbd className="kbd">2</kbd>
                <kbd className="kbd">3</kbd>
                <kbd className="kbd">4</kbd> 评级
              </span>
            )}
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
