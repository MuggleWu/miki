// 新增卡片表单（底部抽屉里）：牌组选择（默认上次用的）+ 正/反面 + 保存。
// 设计文档的边界：不做 markdown 工具栏、不做公式面板——手机上打字本来就慢，能存进去是第一位。
import { useEffect, useState } from 'react'
import { useApp } from '../store'
import { useWorkspace } from '../use-workspace'
import { PREF_KEYS, prefGet, prefSet } from '@mobile/prefs'

/**
 * 这一刻该往哪个牌组加卡。优先级：用户选过的（还在）> 发起处的牌组（还在）> 上次用的（还在）> 第一个。
 *
 * 为什么抽成纯函数：这段判断原来散在一个 effect 里（异步读偏好后无条件 setDeckId），
 * 而 deckInfos() 每次渲染都返回新数组、被当成依赖，于是每次渲染都重放一遍，
 * 用户选完牌组一打字就被弹回「上次用的牌组」。手机端**没有**「移动牌组」功能（桌面端有），
 * 卡片落错牌组只能删了重建——所以这条优先级值得能在 node 里穷举。
 * 收成一个入参对象而不是三个位置参数：chosenId / defaultId / lastUsedId 都是 string | null，
 * 位置写反了编译器一句话都不会说，而写反的语义正好就是这个 bug（偏好盖掉用户的选择）。
 * 另外，已选/发起处/上次用的牌组都可能已被删除，三个都要重新确认还在列表里才认。
 */
export function pickDeckId(input: {
  deckIds: readonly string[]
  chosenId: string | null
  /** 发起处的牌组（学习页「⋮ → 新增卡片」传当前牌组）：没选过时的第一顺位 */
  defaultId?: string | null
  lastUsedId: string | null
}): string {
  const { deckIds, chosenId, defaultId = null, lastUsedId } = input
  if (deckIds.length === 0) return ''
  if (chosenId !== null && deckIds.includes(chosenId)) return chosenId
  if (defaultId !== null && deckIds.includes(defaultId)) return defaultId
  if (lastUsedId !== null && deckIds.includes(lastUsedId)) return lastUsedId
  return deckIds[0]
}

export function AddCardForm({
  onDone,
  defaultDeckId = null
}: {
  onDone(): void
  defaultDeckId?: string | null
}): JSX.Element {
  const ws = useWorkspace()
  const bump = useApp((s) => s.bump)
  const notify = useApp((s) => s.notify)

  // 每次渲染直接算：卡片是往哪个牌组加，取决于这一刻有哪些牌组，
  // 缓存它反而会在"先建牌组再开抽屉"的路径上给出过期的空列表
  const decks = ws.deckInfos()
  // 用户在下拉里选过的牌组（null = 还没选过）。它与「上次用的牌组」分开存，是为了把
  // 「谁说了算」落在 state 结构里：显式选择一旦落地，迟到的偏好就再也覆盖不了它
  const [chosenId, setChosenId] = useState<string | null>(null)
  const [lastUsedId, setLastUsedId] = useState<string | null>(null)
  const [front, setFront] = useState('')
  const [back, setBack] = useState('')
  const [busy, setBusy] = useState(false)

  // 当前牌组在渲染期派生，不落 state：一旦让某个 effect 去写它，就得再回答「用户选过没有」，
  // 而这个答案用 ref 记还是会跟迟到的异步结果赛跑。派生以后只有用户的 onChange 能改它
  const deckId = pickDeckId({ deckIds: decks.map((d) => d.id), chosenId, defaultId: defaultDeckId, lastUsedId })

  // 「上次用的牌组」只是还没得选时的兜底：挂载时读一次就够——抽屉内容是按需挂载的
  // （每次打开都是一次新挂载，见 DecksPage 那处的注释），所以「打开即读一次」正是想要的粒度。
  // 读回来不写 deckId，交给 pickDeckId 按优先级决定；别把 decks 加进依赖，每次渲染都是新数组引用
  useEffect(() => {
    let alive = true
    void prefGet(PREF_KEYS.lastDeckId).then((last) => {
      if (alive) setLastUsedId(last)
    })
    return () => {
      alive = false
    }
  }, [])

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
        <select value={deckId} onChange={(e) => setChosenId(e.target.value)}>
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
