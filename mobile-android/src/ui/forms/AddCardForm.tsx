// 新增卡片表单（底部抽屉里）：牌组选择（默认上次用的）+ 正/反面 + 保存。
// 设计文档的边界：不做 markdown 工具栏、不做公式面板——手机上打字本来就慢，能存进去是第一位。
import { useEffect, useState } from 'react'
import { useApp } from '../store'
import { useWorkspace } from '../use-workspace'
import { PREF_KEYS, prefGet, prefSet } from '@mobile/prefs'

export function AddCardForm({ onDone }: { onDone(): void }): JSX.Element {
  const ws = useWorkspace()
  const bump = useApp((s) => s.bump)
  const notify = useApp((s) => s.notify)

  // 每次渲染直接算：卡片是往哪个牌组加，取决于这一刻有哪些牌组，
  // 缓存它反而会在"先建牌组再开抽屉"的路径上给出过期的空列表
  const decks = ws.deckInfos()
  const [deckId, setDeckId] = useState(() => decks[0]?.id ?? '')
  const [front, setFront] = useState('')
  const [back, setBack] = useState('')
  const [busy, setBusy] = useState(false)

  // 默认选上次用过的牌组（拿不到就用第一个）
  useEffect(() => {
    let alive = true
    void prefGet(PREF_KEYS.lastDeckId).then((last) => {
      if (alive && last && decks.some((d) => d.id === last)) setDeckId(last)
    })
    return () => {
      alive = false
    }
  }, [decks])

  const canSave = deckId !== '' && front.trim() !== '' && !busy

  if (decks.length === 0) {
    return (
      <div className="form">
        <p className="muted">还没有牌组。卡片必须有归属，先用「新增牌组」建一个，再回来加卡。</p>
        <button className="btn" onClick={onDone}>
          知道了
        </button>
      </div>
    )
  }

  async function save(): Promise<void> {
    if (!canSave) return
    setBusy(true)
    try {
      await ws.addCard(deckId, front.trim(), back.trim())
      await prefSet(PREF_KEYS.lastDeckId, deckId)
      bump()
      notify('已新增卡片')
      onDone()
    } catch (e) {
      notify(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <label className="field">
        <span>牌组</span>
        <select value={deckId} onChange={(e) => setDeckId(e.target.value)}>
          {decks.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>正面</span>
        <textarea rows={3} value={front} onChange={(e) => setFront(e.target.value)} placeholder="问题" />
      </label>
      <label className="field">
        <span>背面</span>
        <textarea rows={3} value={back} onChange={(e) => setBack(e.target.value)} placeholder="答案" />
      </label>
      <button className="btn primary" type="submit" disabled={!canSave}>
        {busy ? '保存中…' : '保存'}
      </button>
    </form>
  )
}
