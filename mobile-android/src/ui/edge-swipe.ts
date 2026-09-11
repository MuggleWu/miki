// 抽屉手势的判定规则（纯函数，不碰 DOM，便于单测）。
//
// 模型：抽屉有 0…-width 的横向偏移（0 = 完全打开，-width = 完全收起），手指横向移动多少，
// 抽屉就跟着移动多少；松手时越过一半就吸附到打开，否则吸附回收起。判定"这一下算不算横向
// 拖动"、"松手落哪边"都是纯计算，放在这里可以被穷举验证；DOM 事件注册不是。

/** 起手点必须落在左边这么宽的一条竖带里（CSS px）——再宽就会跟页面内容抢手势 */
export const EDGE = 28
/** 位移超过这个量才判定方向，避免手指抖动就把页面滚动变成拉抽屉 */
const DIRECTION_SLOP = 6
/** 横向位移要达到纵向的这么多倍才算"横向拖动"（纵向留给页面/抽屉内滚动） */
const DIRECTION_RATIO = 1.2

export interface Point {
  x: number
  y: number
}

export type DragAxis = 'horizontal' | 'vertical' | 'none'

/** 起手点是否在左边缘（从关闭状态拉出抽屉的唯一入口） */
export function inEdgeZone(x: number): boolean {
  return x <= EDGE
}

/** 这一下是在横拖还是纵滚。none = 还没动够，先不下结论 */
export function dragAxis(start: Point, now: Point): DragAxis {
  const dx = now.x - start.x
  const dy = now.y - start.y
  if (Math.abs(dx) < DIRECTION_SLOP && Math.abs(dy) < DIRECTION_SLOP) return 'none'
  return Math.abs(dx) > Math.abs(dy) * DIRECTION_RATIO ? 'horizontal' : 'vertical'
}

/** 从"关闭"开始右拖 dx 时的偏移（clamp 在 [-width, 0]，拖过头也不会把抽屉拉出屏幕） */
export function dragOffsetFromClosed(dx: number, width: number): number {
  return Math.max(-width, Math.min(0, -width + dx))
}

/** 从"打开"开始左拖 dx 时的偏移（dx 为负；同样 clamp） */
export function dragOffsetFromOpen(dx: number, width: number): number {
  return Math.max(-width, Math.min(0, dx))
}

/** 松手落点：越过一半就算打开，否则收回 */
export function shouldSnapOpen(offset: number, width: number): boolean {
  return offset > -width / 2
}

/** 列表里跟手的进度（0 = 收起，1 = 全开），用来同步遮罩的不透明度 */
export function drawerProgress(offset: number, width: number): number {
  if (width <= 0) return 1
  return Math.min(1, Math.max(0, 1 + offset / width))
}
