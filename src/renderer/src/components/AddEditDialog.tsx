// 添加/编辑卡片弹窗（S3/S4）：正反面双栏 markdown 编辑 + 预览，cmd+enter 提交
// 添加模式提交后弹窗保留并清空输入（连续新增场景），Esc/取消才关闭
import { useEffect, useRef, useState } from 'react'
import { Md } from '../md'
import { useApp } from '../store'

export function AddEditDialog() {
  const dialog = useApp((s) => s.dialog)
  const decks = useApp((s) => s.decks)
  const closeDialog = useApp((s) => s.closeDialog)
  const reload = useApp((s) => s.reload)

  const [deckId, setDeckId] = useState('')
  const [front, setFront] = useState('')
  const [back, setBack] = useState('')
  const [loaded, setLoaded] = useState(false)
  const frontRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!dialog) return
    setDeckId(dialog.deckId ?? decks[0]?.id ?? '')
    setFront('')
    setBack('')
    setLoaded(dialog.mode === 'add')
    if (dialog.mode === 'edit' && dialog.cardId) {
      void window.miki.getCard(dialog.cardId).then((card) => {
        if (card) {
          setFront(card.front)
          setBack(card.back)
        }
        setLoaded(true)
      })
    }
  }, [dialog, decks])

  if (!dialog) return null

  const submit = async () => {
    if (front.trim() === '' && back.trim() === '') return
    if (dialog.mode === 'add') {
      if (!deckId) return
      await window.miki.addCard(deckId, front, back)
      // 连续新增：保留弹窗，清空输入继续录下一张
      setFront('')
      setBack('')
      frontRef.current?.focus()
    } else if (dialog.cardId) {
      await window.miki.updateCard(dialog.cardId, front, back)
      closeDialog()
    }
    await reload()
  }

  return (
    <div className="overlay">
      <div
        className="modal dialog-wide"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void submit()
          }
          if (e.key === 'Escape') closeDialog()
        }}
      >
        <h3>{dialog.mode === 'add' ? '添加卡片' : '编辑卡片'}</h3>
        {dialog.mode === 'add' && (
          <div className="form-row">
            <label>牌组</label>
            <select value={deckId} onChange={(e) => setDeckId(e.target.value)}>
              {decks.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {loaded && (
          <>
            <div className="dual">
              <div>
                <div className="tag">
                  <span>正面（Markdown）</span>
                </div>
                <textarea
                  ref={frontRef}
                  autoFocus={dialog.mode === 'add'}
                  value={front}
                  onChange={(e) => setFront(e.target.value)}
                  placeholder="问题 / 提示"
                />
              </div>
              <div>
                <div className="tag">
                  <span>正面预览</span>
                </div>
                <div className="preview">
                  <Md source={front} />
                </div>
              </div>
            </div>
            <div className="dual">
              <div>
                <div className="tag">
                  <span>反面（Markdown）</span>
                </div>
                <textarea
                  value={back}
                  onChange={(e) => setBack(e.target.value)}
                  placeholder="答案"
                />
              </div>
              <div>
                <div className="tag">
                  <span>反面预览</span>
                </div>
                <div className="preview">
                  <Md source={back} />
                </div>
              </div>
            </div>
          </>
        )}
        <div className="actions">
          <span style={{ color: 'var(--text-dim)', fontSize: 12, marginRight: 'auto', alignSelf: 'center' }}>
            <kbd className="kbd">⌘</kbd> + <kbd className="kbd">↩</kbd> 提交 · <kbd className="kbd">esc</kbd> 关闭
          </span>
          <button onClick={closeDialog}>取消</button>
          <button className="primary" onClick={() => void submit()}>
            {dialog.mode === 'add' ? '添加' : '确认'}
          </button>
        </div>
      </div>
    </div>
  )
}
