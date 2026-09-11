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

/** 列表里跟手的进度（0 = 收起，1 = 全开），用来同步遮罩的不透明度 */
export function drawerProgress(offset: number, width: number): number {
  if (width <= 0) return 1
  return Math.min(1, Math.max(0, 1 + offset / width))
}

/**
 * 轻扫（flick）的门槛与取样。
 *
 * 只看位置是不够的：从收起状态快速往右轻扫 60px 就松手，位置远没到半宽，按位置判定会被
 * "收回原位"——用户看到的就是"轻轻一滑没用，反而抖回原样"。所以加入速度：甩得够快就按
 * 方向定结果（往右开、往左关），与甩出去多远无关；这是抽屉/底部面板的通用手感。
 */
/** 速度门槛（px/ms，CSS px）：约 350px/s。轻扫通常 0.5–2，慢拖通常 <0.2 */
export const FLICK_VELOCITY = 0.35
/** 轻扫至少要真的走过这么远，避免手指抖动造成的速度尖峰翻状态 */
export const FLICK_MIN_DISTANCE = 12
/** 速度只看最近这一段时间的采样，更早的位移不算"甩" */
export const VELOCITY_WINDOW = 100

export interface DragSample {
  x: number
  /** 事件时间戳（performance.now 同一时间原点，用 touch 事件的 timeStamp） */
  t: number
}

/** 从采样序列算水平速度（px/ms，正 = 向右）。只取最近 VELOCITY_WINDOW 毫秒 */
export function dragVelocity(samples: DragSample[]): number {
  if (samples.length < 2) return 0
  const last = samples[samples.length - 1]
  let first = last
  for (let i = samples.length - 1; i >= 0; i--) {
    if (last.t - samples[i].t > VELOCITY_WINDOW) break
    first = samples[i]
  }
  const dt = last.t - first.t
  if (dt <= 0) return 0
  return (last.x - first.x) / dt
}

/**
 * 松手落点：**先看速度**（甩得够快就按甩的方向），再看位置（过半算打开）。
 * travelled = 按下到松手的横向总位移，用来挡掉"抖一下但速度很大"的误判。
 */
export function shouldSnapOpen(offset: number, width: number, velocity = 0, travelled = 0): boolean {
  if (travelled >= FLICK_MIN_DISTANCE && Math.abs(velocity) >= FLICK_VELOCITY) return velocity > 0
  return offset > -width / 2
}
