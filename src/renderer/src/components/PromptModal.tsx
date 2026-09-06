// 简易弹窗：创建/重命名牌组、删除确认
import { useEffect, useRef, useState } from 'react'

export function PromptModal(props: {
  title: string
  initialValue?: string
  placeholder?: string
  danger?: boolean
  confirmText?: string
  onConfirm: (value: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(props.initialValue ?? '')
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  const submit = () => {
    if (!props.danger && value.trim() === '') return
    props.onConfirm(value.trim())
  }

  return (
    <div className="overlay" onMouseDown={props.onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{props.title}</h3>
        <div className="form-row">
          <input
            ref={ref}
            value={value}
            placeholder={props.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') props.onClose()
            }}
          />
        </div>
        <div className="actions">
          <button onClick={props.onClose}>取消</button>
          <button
            className={props.danger ? 'danger' : 'primary'}
            style={props.danger ? { background: 'var(--danger)', color: '#fff', borderColor: 'var(--danger)' } : undefined}
            onClick={submit}
          >
            {props.confirmText ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  )
}
