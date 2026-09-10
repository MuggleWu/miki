// 拖拽工具：表格列宽拖柄与垂直分隔条（拖动期间监听 window 事件）
//
// 【为什么需要「拖动中」这个标志】
// 拖柄上 mouseup 之后，浏览器会在 th（或其祖先）上同步派发一次 click；表头排序必须跳过
// 这一次 click，否则拖完列宽会顺手把排序也改了。
//
// 【原实现的缺陷】计数只在 mouseup 里自减，没有任何补结算路径：
//   mouseup 丢了（拖到窗口外松手、被系统弹窗/截图工具抢走鼠标、拖动中窗口失焦）→ 计数
//   永久 > 0，isDragResizing() 恒为真，表头点击排序被永久忽略（Browser onHeaderClick
//   直接 return），而用户看不出任何原因。
//
// 【本条实现】把「本次拖动」的结算做成确定性的：
//   1. 每个拖动单元自建结算函数，只结算一次（幂等），结算时摘掉自己的全部监听
//   2. 新拖动开始前先补结算上一次（mouseup 丢了也不会累加）；补结算立即减计数——
//      延迟的话，在新拖动「已按下但还没移动」的同步窗口里计数会短暂为 0，那次收尾
//      click 会被当成排序点击放行（拖列宽顺手改了排序）
//   3. 窗口失焦也结算
//   4. 陈旧判定：计数挂着、但本次拖动移动过又停住很久 → 上一次拖动的残留（mouseup 丢了）。
//      用户下一步通常是直接点表头排序，不能要求他先再拖一次；判定只看本次拖动自己的
//      移动记录，避免两次拖动互相影响
let activeDrags = 0
/** 尚未结算的拖动单元（最后开始的那个），供补结算与陈旧判定使用 */
let pending: { settle: (delayed: boolean) => void; probe: () => boolean } | null = null
/** 鼠标停住多久算「这不是拖动收尾的那次 click」；同一手势的收尾是毫秒级 */
const STALE_DRAG_MS = 500

export function isDragResizing(): boolean {
  if (activeDrags <= 0) return false
  // 只问最后开始的那个单元：它是当前手势（用户正在拖），或上一次拖动的残留（mouseup 丢了）。
  // 由它自己结算自己，不会连带结算刚按下的新拖动。
  return pending ? pending.probe() : true
}

/** 拖拽期间监听 window 事件（详见文件头注释） */
export function dragAxis(e: React.MouseEvent, axis: 'x' | 'y', onMove: (delta: number) => void): void {
  pending?.settle(false) // 上一次的 mouseup 丢了也在这里补上
  const start = axis === 'x' ? e.clientX : e.clientY
  let moved = false
  let lastMoveAt = 0
  const move = (ev: MouseEvent) => {
    moved = true
    lastMoveAt = Date.now()
    onMove((axis === 'x' ? ev.clientX : ev.clientY) - start)
  }

  let settled = false
  /**
   * @param delayed 正常 mouseup 必须延迟自减（覆盖其同步派发的那个 click）；
   *   补偿结算 / 失焦立即自减
   */
  const settle = (delayed: boolean) => {
    if (settled) return // 幂等：mouseup / blur / 新拖动 / 陈旧判定都可能来结算
    settled = true
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', onUp)
    window.removeEventListener('blur', onBlur)
    if (pending?.probe === probe) pending = null
    if (delayed) setTimeout(() => void activeDrags--, 0)
    else activeDrags--
  }
  const onUp = () => settle(true)
  const onBlur = () => settle(false)
  /** 「这次拖动是否还该屏蔽 click」；陈旧则顺带把自己结算掉 */
  const probe = () => {
    if (!moved) return true // 刚按下还没动：属于拖动
    if (Date.now() - lastMoveAt <= STALE_DRAG_MS) return true // 正常收尾
    settle(false) // 陈旧残留：结算掉，这次 click 该排序
    return false
  }
  activeDrags++
  pending = { settle, probe }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', onUp)
  window.addEventListener('blur', onBlur)
}

/** 仅供测试：把模块级拖动状态复位（模块状态跨用例共享，不清会串味） */
export function resetDragStateForTest(): void {
  pending?.settle(false)
  pending = null
  activeDrags = 0
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
