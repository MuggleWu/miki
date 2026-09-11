// 二次确认弹层：删除这类不可逆操作用它兜一道。
// 语音上刻意写清"删的是什么、能不能撤"——确认框只说"确定吗"等于没问。
import type { ReactNode } from 'react'
import { Sheet } from './Sheet'

interface Props {
  open: boolean
  title: string
  /** 说清后果：能不能撤销、影响范围有多大 */
  detail: ReactNode
  confirmText: string
  onConfirm(): void
  onCancel(): void
}

export function Confirm({ open, title, detail, confirmText, onConfirm, onCancel }: Props): JSX.Element {
  return (
    <Sheet open={open} title={title} onClose={onCancel}>
      <p className="muted">{detail}</p>
      <div className="row-btns">
        <button className="btn" onClick={onCancel}>
          取消
        </button>
        <button className="btn danger" onClick={onConfirm}>
          {confirmText}
        </button>
      </div>
    </Sheet>
  )
}
