// 拖拽工具：表格列宽拖柄与垂直分隔条（拖动期间监听 window 事件）
export function dragAxis(
  e: React.MouseEvent,
  axis: 'x' | 'y',
  onMove: (delta: number) => void
): void {
  const start = axis === 'x' ? e.clientX : e.clientY
  const move = (ev: MouseEvent) => onMove((axis === 'x' ? ev.clientX : ev.clientY) - start)
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

/** 表头内右缘拖柄：水平拖动调整列宽 */
export function ColResizer(props: { width: number; onResize: (w: number) => void }) {
  return (
    <span
      className="col-resizer"
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        const start = props.width
        dragAxis(e, 'x', (dx) => props.onResize(start + dx))
      }}
    />
  )
}

/** 垂直分隔条：水平拖动调整相邻面板宽度 */
export function VResizer(props: { width: number; onResize: (w: number) => void }) {
  return (
    <div
      className="vresizer"
      onMouseDown={(e) => {
        e.preventDefault()
        const start = props.width
        dragAxis(e, 'x', (dx) => props.onResize(start + dx))
      }}
    />
  )
}
