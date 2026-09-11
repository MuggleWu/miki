// 抽屉手势的判定规则（纯函数，不碰 DOM，便于单测）。
//
// 规则本身只有一条：**起点在左边缘 + 横向位移占主导 + 超过阈值**。分开放在这里而不是
// 写进 hook 里，是因为"什么算一次打开手势"是可以被穷举验证的，而 DOM 事件注册不是。

/** 起点必须落在左边这么宽的一条竖带里（CSS px）——太宽会跟页面内容抢手势 */
export const EDGE = 24
/** 要滑出这么远才算数，避免误触 */
export const TRIGGER = 56
/** 横向位移必须明显大于纵向，否则是页面在滚 */
export const RATIO = 1.5

export interface Point {
  x: number
  y: number
}

/** 从 start 滑到 now，算不算"打开抽屉"的手势。canOpen 为假（已经在学习页等）时一律不算。 */
export function shouldOpenDrawer(start: Point, now: Point, canOpen: boolean): boolean {
  if (!canOpen) return false
  if (start.x > EDGE) return false
  const dx = now.x - start.x
  const dy = now.y - start.y
  return dx > TRIGGER && dx > Math.abs(dy) * RATIO
}

/** 抽屉里向左滑关闭：不要求起点贴边（手指本来就在抽屉上），阈值与打开一致。 */
export function shouldCloseDrawer(start: Point, now: Point): boolean {
  const dx = now.x - start.x
  const dy = now.y - start.y
  return dx < -TRIGGER && Math.abs(dx) > Math.abs(dy) * RATIO
}
