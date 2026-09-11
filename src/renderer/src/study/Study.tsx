// 学习页（S 域）：空格流、1-4 评级、A/E/cmd+D/B/cmd+z
import { useCallback, useEffect, useRef, useState } from 'react'
import { Md } from '../md'
import { isTypingTarget, useApp } from '../store'
import { createSeqGuard } from '../staleGuard'
import { MAX_ANSWER_MS, RATING_LABEL, fmtDuePreview as fmtDuePreviewOf } from '../../../shared/format'
import type { Rating, StudyPayload } from '../../../shared/types'

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
  /** 评级在途：闸门（ref 同 tick 生效）+ 按钮禁用反馈 */
  const [answering, setAnswering] = useState(false)
  const [answerError, setAnswerError] = useState<string | null>(null)
  const answeringRef = useRef(false)
  const questionShownAt = useRef<number>(Date.now())
  // 最近一次装载进界面的卡（编辑弹窗确认后的重取用它判断「同卡」→ 保留当前相位）
  const loadedCardIdRef = useRef<string | null>(null)
  // 本页「当前卡」的代次守卫。它同时承担两件事：
  //   1. 快速换牌组时旧的重取响应晚到不得覆盖（原 studySeq 的职责）
  //   2. 改变当前卡的写操作（评级/撤销/删除）发出请求时推进代次，作废此前发起、此后才回包的
  //      重取——否则那条响应带的是「已经答完的同一张卡」的旧快照，会把刚推进的界面盖回去，
  //      而且此时重入闸门已释放，同一张卡会被答第二次（污染 reps/lapses 与 FSRS 调度）。
  // 写操作自己的响应**不**受代次门控：它是权威结果，恒可覆盖并发重取的结果。
  const studySeq = useRef(createSeqGuard())
  const previewSeq = useRef(createSeqGuard())
  /** 作废所有在途重取：写操作发出请求时调用 */
  const bumpCardEpoch = useCallback(() => {
    studySeq.current.next()
  }, [])

  const deck = decks.find((d) => d.id === studyDeckId)
  const font = config?.study

  const refresh = useCallback(
    async (id: string, keepPhase = false) => {
      const seq = studySeq.current.next() // 竞态防护：旧响应晚到不得覆盖
      const prevId = loadedCardIdRef.current
      const p = await window.miki.getStudy(id)
      if (!studySeq.current.isLatest(seq)) return
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

  // 评级按钮的下次到期预览（不落盘）；竞态防护：换卡后旧卡的预览晚到不得污染新卡
  useEffect(() => {
    setPreviewDue([])
    const cardId = payload?.card?.id
    if (cardId) {
      const seq = previewSeq.current.next()
      void window.miki.previewIntervals(cardId).then((due) => {
        if (previewSeq.current.isLatest(seq)) setPreviewDue(due)
      })
    }
  }, [payload?.card?.id])

  const answer = useCallback(
    async (rating: Rating) => {
      // 重入闸门：评级键（空格/1-4）可在 IPC 往返期间连按。payload 是闭包快照、
      // setPayload 要等回包后的重渲染才更新，两次调用会读到同一张卡 → 同卡追两条
      // answer 事件，污染 reps/lapses 与 FSRS 的 shortTerm 分支，且撤销只能退一步。
      // 用 ref 而非 state：state 更新要等重渲染，挡不住同一 tick 的第二次按键。
      if (answeringRef.current) return
      if (!payload?.card || !studyDeckId) return
      answeringRef.current = true
      setAnswering(true)
      // 发出请求就先作废在途重取：本调用返回权威的下一张，界面不该被并发重取的旧快照盖回
      bumpCardEpoch()
      try {
        const durationMs = Math.min(Date.now() - questionShownAt.current, MAX_ANSWER_MS)
        const p = await window.miki.answer(payload.card.id, rating, durationMs)
        setAnswerError(null)
        setPayload(p)
        loadedCardIdRef.current = p.card?.id ?? null
        setPhase('question')
        questionShownAt.current = Date.now()
        setStudyCurrentCardId(p.card?.id ?? null)
      } catch (e) {
        // 答不上就是答不上：主进程会把内存态回滚（见 WorkspaceService.answer），界面上必须
        // 说出来 —— 否则用户按了键、画面没变、也没有任何提示，只能反复按（每次都白写一遍）。
        setAnswerError(e instanceof Error ? e.message : String(e))
      } finally {
        answeringRef.current = false
        setAnswering(false)
      }
    },
    [payload, studyDeckId, setStudyCurrentCardId, bumpCardEpoch]
  )

  const showAnswer = useCallback(() => {
    if (!payload?.card) return
    setPhase('answer')
  }, [payload])

  const deleteCurrent = useCallback(async () => {
    if (!payload?.card || !studyDeckId) return
    bumpCardEpoch() // 作废在途重取：删除后紧跟的 refresh 才是权威
    await window.miki.deleteCard(payload.card.id)
    await refresh(studyDeckId)
  }, [payload, studyDeckId, refresh, bumpCardEpoch])

  const undo = useCallback(async () => {
    if (!studyDeckId) return
    bumpCardEpoch() // 作废在途重取：否则撤销结果会被并发重取的旧快照盖回
    const r = await window.miki.undo()
    if (r.restoredCardId && r.card) {
      // 回到被恢复卡的提问态（需求 §7）
      setPayload({ card: r.card, remaining: r.remaining, todayCount: r.todayCount })
      loadedCardIdRef.current = r.card.id
      setPhase('question')
      questionShownAt.current = Date.now()
      setStudyCurrentCardId(r.card.id)
    }
  }, [studyDeckId, setStudyCurrentCardId, bumpCardEpoch])

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
        openDialog({ mode: 'edit', deckId: null, cardId: payload.card.id })
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [phase, answer, showAnswer, deleteCurrent, undo, payload, openDialog])

  const card = payload?.card

  // 预览文案与移动端共用同一实现（shared/format），避免两端显示成不同的数
  const fmtDuePreview = (due: number): string => fmtDuePreviewOf(due)

  return (
    <div className="study">
      {answerError ? (
        <div className="damage-banner">
          <span>这次评级没有存下来：{answerError}（卡片状态已回滚，可以直接再按一次）</span>
          <button className="damage-dismiss" onClick={() => setAnswerError(null)}>
            知道了
          </button>
        </div>
      ) : null}
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
          <div
            className="cardbox"
            style={{ fontFamily: font?.fontFamily || undefined, fontSize: font?.fontSize || undefined }}
          >
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
                <button key={r} className={`rate-card rate-${r}`} disabled={answering} onClick={() => void answer(r)}>
                  <span className="rate-top">
                    {RATING_LABEL[r]}
                    <kbd className="kbd">{r}</kbd>
                  </span>
                  <span className="rate-due">{previewDue[r - 1] ? fmtDuePreview(previewDue[r - 1]) : ' '}</span>
                </button>
              ))}
            </div>
          )}

          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              gap: 18,
              marginTop: 14,
              color: 'var(--text-dim)',
              fontSize: 12
            }}
          >
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
            <span style={{ cursor: 'pointer' }} onClick={() => openBrowser(studyDeckId, card?.id ?? null)}>
              <kbd className="kbd">B</kbd> 卡片库
            </span>
          </div>
        </>
      )}
    </div>
  )
}
