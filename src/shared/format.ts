// 展示层格式化（纯函数，两端共用）。
//
// 放 shared 而不是各端各写一份：间隔预览、耗时口径这类东西一旦分叉，同一条数据在手机和电脑上
// 会显示成不同的数，而"哪个才对"要人肉比对才能发现。
//
// 目前服务于学习页的评级按钮："下次间隔预览"与"这次答题花了多久"。
import type { Rating } from './types'

/**
 * 单卡答题耗时上限（ms）：超出即视为「人不在」而不是「在想」。
 *
 * durationMs 是评级键与题目上屏的墙钟差值，待机/合盖/去吃饭都会算进去——桌面端真实数据
 * 561 条里最大一条 29.9 分钟，会把统计页的「平均单卡答题耗时」整个带偏。
 * 分布：P50 4.8 秒、P90 15 秒；封顶取 5 分钟只影响 0.5% 的样本，既保留「这题我花了 4 分钟」
 * 的真实信息，又堵住「待机 8 小时」。只影响耗时统计，不参与 FSRS 调度。
 */
export const MAX_ANSWER_MS = 300_000

/** 把墙钟差值裁到合理区间（负数/0 视为未上报，返回 undefined） */
export function clampAnswerMs(ms: number): number | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return undefined
  return Math.min(Math.round(ms), MAX_ANSWER_MS)
}

/** 毫秒 → 人话（不足 1 分钟按分钟显示，即 0 分钟） */
export function fmtInterval(ms: number): string {
  const days = ms / 86_400_000
  if (days >= 1) return `${Math.floor(days)} 天`
  const mins = Math.floor(ms / 60_000)
  if (mins >= 60) return `${Math.floor(mins / 60)} 小时`
  return `${mins} 分钟`
}

/** 到期时刻 → 评级按钮上的「+N 天」预览（已到期显示「现在」；超过一个月按 30.44 天/月折算） */
export function fmtDuePreview(due: number, now: number = Date.now()): string {
  const diff = due - now
  if (diff <= 0) return '现在'
  if (diff / 86_400_000 >= 31) return `+${(diff / (30.44 * 86_400_000)).toFixed(1)} 个月`
  return `+${fmtInterval(diff)}`
}

/** 四档评级的按钮文案（两端一致；顺序即显示顺序） */
export const RATING_LABEL: Record<Rating, string> = {
  1: '重来',
  2: '困难',
  3: '良好',
  4: '轻松'
}
