// 底部弹层：抽屉式操作菜单与新增表单共用。
// 用 <dialog> 而不是自己撸遮罩：原生元素自带焦点陷阱与 Esc 关闭，Android 返回键也会先关它。
import { useEffect, useRef, type ReactNode } from 'react'

interface Props {
  open: boolean
  title: string
  onClose(): void
  children: ReactNode
}

export function Sheet({ open, title, onClose, children }: Props): JSX.Element | null {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="sheet"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        // 点遮罩区（dialog 自身）关闭；点内容区不关
        if (e.target === ref.current) onClose()
      }}
    >
      <div className="sheet-inner">
        <header className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className="sheet-body">{children}</div>
      </div>
    </dialog>
  )
}
