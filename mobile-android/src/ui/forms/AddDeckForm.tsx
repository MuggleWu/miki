// 新增牌组表单（底部抽屉里）。移动端 v1 不做重命名/删除牌组——那两个操作桌面端更顺手，
// 而删除一旦做错，代价是整组卡从学习流里消失。
import { useState } from 'react'
import { useApp } from '../store'

export function AddDeckForm({ onDone }: { onDone(): void }): JSX.Element {
  const ws = useApp((s) => s.ws)!
  const bump = useApp((s) => s.bump)
  const notify = useApp((s) => s.notify)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const canSave = name.trim() !== '' && !busy

  async function save(): Promise<void> {
    if (!canSave) return
    setBusy(true)
    try {
      await ws.addDeck(name.trim())
      bump()
      notify('已新增牌组')
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
        <span>牌组名</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：读书笔记" />
      </label>
      <p className="muted">新建的牌组会写进工作区的 decks.json，同步时随其他文件一起推上去。</p>
      <button className="btn primary" type="submit" disabled={!canSave}>
        {busy ? '保存中…' : '保存'}
      </button>
    </form>
  )
}
