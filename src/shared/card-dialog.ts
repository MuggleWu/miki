// 卡片弹窗子窗口（独立 BrowserWindow 承载添加/编辑表单）：main / renderer 共用的纯逻辑。
// 本文件禁止 import electron——单测在纯 node 环境直接覆盖，主进程窗口 glue 只做薄封装
import type { DialogState } from './types'

/** 弹窗窗口默认尺寸：宽放表单双栏（主窗口内 .dialog-wide 默认 72vw @1280 ≈ 920），高随 672 容纳双栏+操作行 */
export const CARD_DIALOG_DEFAULTS = { width: 920, height: 672 } as const
/** 弹窗窗口最小尺寸（BrowserWindow minWidth/minHeight 与拖拽缩放下限同源） */
export const CARD_DIALOG_MIN = { width: 520, height: 380 } as const

export interface CardDialogBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 弹窗窗口的位置/尺寸持久化形态（x/y 为 null = 无记录，开窗时居中于主窗口） */
export interface CardDialogWindowState {
  x: number | null
  y: number | null
  width: number
  height: number
}

/** clamp：hi < lo（工作区比最小尺寸还小）时退化为 lo */
export function clampNum(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi))
}

/** 渲染层路由：弹窗子窗口加载 #card-dialog（file: / dev http: 两种加载方式都成立） */
export function isCardDialogHash(url: string): boolean {
  try {
    return new URL(url).hash === '#card-dialog'
  } catch {
    return false
  }
}

/** 任意 URL 追加/替换 hash 为 #card-dialog（保留查询串） */
export function withCardDialogHash(url: string): string {
  const u = new URL(url)
  u.hash = 'card-dialog'
  return u.toString()
}

/** 弹窗窗口初始几何：有持久化记录 → 沿用并整窗钳回工作区（拔显示器/分辨率变化不出屏）；
 * 无记录或 x/y 缺一 → 默认尺寸居中偏上（1/3 高度线）于主窗口，再钳回工作区 */
export function dialogWindowBounds(
  saved: CardDialogWindowState | null | undefined,
  parentBounds: CardDialogBounds,
  workArea: CardDialogBounds
): CardDialogBounds {
  const width = Math.min(
    Math.max(saved?.width ?? CARD_DIALOG_DEFAULTS.width, CARD_DIALOG_MIN.width),
    Math.max(workArea.width, 1)
  )
  const height = Math.min(
    Math.max(saved?.height ?? CARD_DIALOG_DEFAULTS.height, CARD_DIALOG_MIN.height),
    Math.max(workArea.height, 1)
  )
  let x: number
  let y: number
  if (saved?.x != null && saved?.y != null) {
    x = saved.x
    y = saved.y
  } else {
    x = Math.round(parentBounds.x + (parentBounds.width - width) / 2)
    y = Math.round(parentBounds.y + (parentBounds.height - height) / 3)
  }
  return {
    x: clampNum(x, workArea.x, workArea.x + workArea.width - width),
    y: clampNum(y, workArea.y, workArea.y + workArea.height - height),
    width,
    height
  }
}

/** DialogState → IPC 载荷：只保留弹窗需要的字段；edit 模式不依赖 deckId（卡自带），add 模式不依赖 cardId */
export function dialogToPayload(d: DialogState): {
  mode: 'add' | 'edit'
  deckId: string | null
  cardId: string | null
} {
  return {
    mode: d.mode,
    deckId: d.mode === 'add' ? (d.deckId ?? null) : null,
    cardId: d.mode === 'edit' ? d.cardId : null
  }
}

/** IPC 载荷 → DialogState：信任边界校验。mode 必须是 add/edit；edit 必须带非空 cardId（缺失拒绝开窗，
 * 而不是静默转 add 弹出一张空表单）；非法载荷返回 null 由主进程丢弃 */
export function payloadToDialog(p: unknown): DialogState | null {
  if (typeof p !== 'object' || p === null) return null
  const o = p as Record<string, unknown>
  if (o.mode !== 'add' && o.mode !== 'edit') return null
  const deckId = typeof o.deckId === 'string' && o.deckId !== '' ? o.deckId : null
  const cardId = typeof o.cardId === 'string' && o.cardId !== '' ? o.cardId : null
  if (o.mode === 'edit' && cardId === null) return null
  return { mode: o.mode, deckId, cardId: o.mode === 'edit' ? cardId : null }
}
