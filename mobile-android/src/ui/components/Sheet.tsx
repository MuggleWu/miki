// 弹层：抽屉式操作菜单、新增表单、编辑页共用。
// 用 <dialog> 而不是自己撸遮罩：原生元素自带焦点陷阱与 Esc 关闭。
//
// 注意 Android 返回键：它是原生事件，走 Capacitor 的 backButton 回到 JS，**不会**触发
// <dialog> 自己的 cancel。所以弹层开着时必须自己登记到 store 的弹层栈里（见 store.sheetStack），
// 让返回键先关弹层、再退路由；否则弹层开着按返回会直接退出整页。
import { useEffect, useRef, type ReactNode } from 'react'
import { useApp } from '../store'

interface Props {
  open: boolean
  title: string
  onClose(): void
  children: ReactNode
  /**
   * 全屏形态：编辑长文本用。
   * 手机上键盘一弹就占掉半屏，底部抽屉里只剩两行可见，写解析要不停滚动。
   * 全屏仍然用 <dialog>（不换成路由）：换路由会卸载学习页，把当前会话的刷题进度丢掉。
   */
  full?: boolean
}

export function Sheet({ open, title, onClose, children, full = false }: Props): JSX.Element | null {
  const ref = useRef<HTMLDialogElement>(null)

  // onClose 通常是内联箭头函数，每次渲染都是新的；用 ref 取最新的那个，
  // 这样登记只做一次（否则每次渲染都会 push/pop 一轮）
  const closeRef = useRef(onClose)
  const pushSheet = useApp((s) => s.pushSheet)
  const popSheet = useApp((s) => s.popSheet)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  // 在 effect 里同步最新回调（渲染期间不写 ref），登记只做一次
  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) return
    const close = (): void => closeRef.current()
    pushSheet(close)
    return () => popSheet(close)
  }, [open, pushSheet, popSheet])

  return (
    <dialog
      ref={ref}
      className={full ? 'sheet sheet-full' : 'sheet'}
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
