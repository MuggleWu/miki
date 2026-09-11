// 编辑卡片表单：正面 / 反面两个 textarea + 预览切换 + 保存。
//
// 全屏页承载（不是底部抽屉）：手机上写长文本时键盘要占掉半屏，
// 抽屉里只剩两行可见，改起来要不停滚动。设计文档也是这么定的。
//
// 两处用过它：学习页的「更多 → 编辑」底部抽屉、以及卡片库点行进详情（M3）。
//
// 乐观锁的关键细节：基准版本必须是**打开表单那一刻**的 updatedAt，而不是提交时的实时值。
// 取实时值等于没校验——别处（同步拉取、另一屏）改了卡，内存对象上的 updatedAt 就变了，
// 提交时拿它比对永远相等，那次改动静默被覆盖。所以这里在挂载时把
// 「打开时的内容 + 版本号」一起冻进 ref，之后只用它做比对。
// 冲突时不写盘，只提示：让用户自己决定要不要用旧内容覆盖。
import { useState } from 'react'
import { Md } from '../md'
import { useApp } from '../store'

interface Props {
  cardId: string
  /** changed=true 表示真的落盘了（调用方据此决定要不要刷新屏幕上的内容） */
  onDone(changed: boolean): void
}

interface Opened {
  front: string
  back: string
  updatedAt: number
}

export function CardEditForm({ cardId, onDone }: Props): JSX.Element {
  const ws = useApp((s) => s.ws)!
  const notify = useApp((s) => s.notify)
  const card = ws.getCard(cardId)

  // 本次编辑的起点（内容与版本号），用惰性初始 state 冻住：只在挂载时算一次，
  // 之后别处再改这张卡也不会影响本次比对的基准。用 ref 存会在渲染期读 ref，多一条无谓告警。
  const [base] = useState<Opened | null>(() =>
    card && !card.deletedAt ? { front: card.front, back: card.back, updatedAt: card.updatedAt } : null
  )
  const [front, setFront] = useState(base?.front ?? '')
  const [back, setBack] = useState(base?.back ?? '')
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  // 预览是"看效果"，编辑是"改内容"：手机上两者不能同时可见（宽度不够），所以做切换
  const [preview, setPreview] = useState(false)

  if (!base) {
    return (
      <div className="form">
        <p className="muted">这张卡已被删除。</p>
        <button className="btn" onClick={() => onDone(false)}>
          关闭
        </button>
      </div>
    )
  }

  const dirty = front !== base.front || back !== base.back
  // 解出成非空局部量：save 是函数声明（提升），TS 不在它内部沿用上面 if 的收窄
  const expectedUpdatedAt = base.updatedAt

  async function save(): Promise<void> {
    if (busy) return
    setBusy(true)
    setConflict(false)
    try {
      const res = await ws.updateCardChecked(cardId, { front, back }, expectedUpdatedAt)
      if (res.status === 'ok') {
        notify('已保存')
        onDone(true)
      } else if (res.status === 'conflict') {
        setConflict(true)
      } else {
        notify('这张卡不存在了')
        onDone(false)
      }
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
      {conflict ? (
        <p className="note">
          这张卡在别处被改过了，直接保存会把那次改动静默覆盖，所以先拦下来。 请把上面的内容复制走，
          关掉后重新打开这张卡再编辑。
        </p>
      ) : null}
      {/* 类名要与设置页的分段控件一致（seg-btn + on）：漏掉 seg-btn 就没有选中态，
          用户看不出当前是编辑还是预览（真机上就是这么发现的） */}
      <div className="seg">
        <button type="button" className={`seg-btn${preview ? '' : ' on'}`} onClick={() => setPreview(false)}>
          编辑
        </button>
        <button type="button" className={`seg-btn${preview ? ' on' : ''}`} onClick={() => setPreview(true)}>
          预览
        </button>
      </div>

      {preview ? (
        <div className="edit-preview">
          <Md source={front} className="preview-front" />
          <hr className="sep" />
          <Md source={back} className="preview-back" />
          <p className="muted">预览用的是渲染后的效果（公式、加粗、列表都会显示出来）。</p>
        </div>
      ) : (
        <>
          <label className="field">
            <span>正面</span>
            <textarea rows={5} value={front} onChange={(e) => setFront(e.target.value)} />
          </label>
          <label className="field">
            <span>背面</span>
            <textarea rows={5} value={back} onChange={(e) => setBack(e.target.value)} />
          </label>
        </>
      )}
      <div className="row-btns">
        <button className="btn" type="button" onClick={() => onDone(false)}>
          取消
        </button>
        <button className="btn primary" type="submit" disabled={!dirty || busy}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </form>
  )
}
