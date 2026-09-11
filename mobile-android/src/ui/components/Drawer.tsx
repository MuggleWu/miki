// 左上汉堡打开的左侧抽屉：牌组 / 卡片库 / 统计 / 设置。
// 用 showModal() 而不是 open 属性：只有模态对话框才有遮罩层与焦点陷阱，
// 而「点遮罩关闭」这个手势正是移动端抽屉的默认期待。
import { useEffect, useRef } from 'react'
import { useApp, type Route } from '../store'
import { useWorkspace } from '../use-workspace'
import { shouldCloseDrawer } from '../edge-swipe'

const ITEMS: { label: string; kind: Route['kind']; note: string }[] = [
  { label: '牌组', kind: 'decks', note: '主页' },
  { label: '卡片库', kind: 'library', note: '搜索与编辑' },
  { label: '统计', kind: 'stats', note: '预测与留存' },
  { label: '设置', kind: 'settings', note: '偏好与数据' }
]

export function Drawer({ open, onClose }: { open: boolean; onClose(): void }): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const ws = useWorkspace()
  const route = useApp((s) => s.route)
  // 从抽屉换页 = 重置导航栈：这些是"同级页"，返回键该回主页而不是回到上一个同级页
  const reset = useApp((s) => s.reset)
  // 抽屉内左滑关闭的手势起点。阈值口径与 use-edge-swipe 一致（见那里的注释）
  const swipe = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="drawer"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
      onTouchStart={(e) => {
        if (e.touches.length !== 1) return
        swipe.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      }}
      onTouchMove={(e) => {
        const s = swipe.current
        if (!s || e.touches.length !== 1) return
        const now = { x: e.touches[0].clientX, y: e.touches[0].clientY }
        if (shouldCloseDrawer(s, now)) {
          swipe.current = null
          onClose()
        }
      }}
      onTouchEnd={() => {
        swipe.current = null
      }}
    >
      <nav className="drawer-inner">
        <header className="drawer-head">
          <h2>miki</h2>
          <p className="muted">今日已学 {ws.todayCount()} 次</p>
        </header>
        {ITEMS.map((it) => (
          <button
            key={it.kind}
            className={`drawer-item${route.kind === it.kind ? ' active' : ''}`}
            onClick={() => {
              reset({ kind: it.kind } as Route)
              onClose()
            }}
          >
            <span className="drawer-label">{it.label}</span>
            <span className="drawer-note muted">{it.note}</span>
          </button>
        ))}
        <footer className="drawer-foot muted">数据只在本机应用私有目录，同步在设置页</footer>
      </nav>
    </dialog>
  )
}
