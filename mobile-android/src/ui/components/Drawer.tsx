// 左上汉堡打开的左侧抽屉：牌组 / 卡片库 / 统计 / 设置。
// 用 showModal() 而不是 open 属性：只有模态对话框才有遮罩层与焦点陷阱，
// 而「点遮罩关闭」这个手势正是移动端抽屉的默认期待。
//
// 开合有两种来源，都由 store 统一表达：
// - 点汉堡 / 菜单键：drawerDrag === null，交给 CSS 的滑入动画；
// - 手指拖动（左边缘拉出、抽屉内左滑收回）：drawerDrag 是当前偏移，跟手；松手后 store
//   把偏移设成落点并打开过渡，滑完再改 open。手势识别在 use-edge-swipe.ts。
import { useEffect, useRef } from 'react'
import { useApp, type Route } from '../store'
import { useWorkspace } from '../use-workspace'
import { drawerProgress } from '../edge-swipe'

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
  const drag = useApp((s) => s.drawerDrag)
  const dragging = useApp((s) => s.drawerDragging)
  const width = useApp((s) => s.drawerWidth)
  const setDrawerWidth = useApp((s) => s.setDrawerWidth)
  const pushSheet = useApp((s) => s.pushSheet)
  const popSheet = useApp((s) => s.popSheet)
  // onClose 是内联函数，用 ref 取最新的，避免每次渲染都重新登记
  const closeRef = useRef(onClose)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  // 抽屉也登记进弹层栈：返回键先关抽屉，再退路由（原生返回键到不了 <dialog> 的 cancel）
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

  // CSS 里宽度是 min(78vw, 320px)，公式在 JS 侧也有一份（手势开始时抽屉还没挂载、量不到）。
  // 挂载后实测一次，让两边以后不会因为改 CSS 而悄悄错位。
  useEffect(() => {
    const el = ref.current
    if (!open || !el) return
    setDrawerWidth(el.getBoundingClientRect().width)
  }, [open, setDrawerWidth])

  // 遮罩跟着拖动进度变淡变浓。::backdrop 读的是**根元素**上的自定义属性
  // （规范里 ::backdrop 继承自 dialog，实现上老版本继承自根元素，写在根元素两边都认）。
  useEffect(() => {
    const root = document.documentElement
    if (open && drag !== null) root.style.setProperty('--scrim', String(drawerProgress(drag, width)))
    else root.style.removeProperty('--scrim')
  }, [open, drag, width])

  return (
    <dialog
      ref={ref}
      className={`drawer${dragging ? ' dragging' : ''}`}
      style={drag === null ? undefined : { transform: `translateX(${drag}px)` }}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
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
