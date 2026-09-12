// 真机现场记录：把键盘/布局相关的读数留在环形缓冲里，出问题时一次性 dump。
//
// 为什么需要它：键盘相关的现象（内容抖动、快速闪动）本质是"同一批值在极短时间内来回跳"。
// 只靠 adb logcat 看实时日志有两个问题——刷得太快看不清序列，事后再连设备又只能看到
// 当下的片段。缓冲区保留最后若干条带毫秒时间戳的记录，配合屏幕上的一次 dump，就能判断
// 是原生让位在变、还是可视视口在变、还是 CSS 变量在反复写。
//
// 数据只在内存里（页面刷新即清空），不上传、不落盘。

/** 保留的最大条数：够看清几十帧的序列，又不会吃内存 */
export const DIAG_MAX = 40

/** 记录一行（自动带毫秒时间戳；node 环境下是空操作） */
export function recordDiag(line: string): void {
  if (typeof window === 'undefined') return
  const buf = diagBuffer()
  buf.push(`${Math.round(performance.now() % 100000)} ${line}`)
  if (buf.length > DIAG_MAX) buf.splice(0, buf.length - DIAG_MAX)
}

/** 缓冲区本体（供测试与 dump 用） */
export function diagBuffer(): string[] {
  if (typeof window === 'undefined') return []
  const w = window as unknown as { __mikiDiag?: string[] }
  return (w.__mikiDiag ??= [])
}

/** 缓冲内容的文本形式（每行一条，dump 时直接打印/上报） */
export function diagDump(): string {
  return diagBuffer().join('\n')
}

/**
 * 关键读数的快照：不只看 CSS 变量的字面值，还要看**元素实际被摆到哪里**。
 *
 * 为什么必须量矩形：闪动是"某个东西的位置在来回跳"，而变量值相同也可能因为别的因素
 * （滚动位置、输入法自身的窗口）导致元素位置变化；反过来，变量在跳但元素没动就不算 bug。
 * 所以这里同时给出：编辑区的底边、输入框的底边、滚动容器的 scrollTop、可视区高度。
 */
export function insetSnapshot(): string {
  if (typeof document === 'undefined') return ''
  const s = getComputedStyle(document.documentElement)
  const get = (name: string): string => s.getPropertyValue(name).trim() || '-'
  const rect = (sel: string): string => {
    const el = document.querySelector(sel)
    if (!el) return '-'
    const r = el.getBoundingClientRect()
    return `${Math.round(r.top)},${Math.round(r.bottom)}`
  }
  const scroller = document.querySelector('.sheet-body, .page-body')
  const focus = document.activeElement
  const focusRect = focus instanceof HTMLElement ? focus.getBoundingClientRect() : null
  return [
    `kb=${get('--kb')}`,
    `blocked=${get('--bottom-blocked')}`,
    `sheet=${rect('.sheet[open]')}`,
    `body=${rect('.sheet[open] .sheet-body, .sheet[open] .sheet-inner')}`,
    `focus=${focusRect ? `${Math.round(focusRect.top)},${Math.round(focusRect.bottom)}` : '-'}`,
    `scrollTop=${scroller ? Math.round(scroller.scrollTop) : '-'}`,
    `vv=${Math.round(window.visualViewport?.height ?? -1)}`,
    `inner=${window.innerHeight}`,
    `layout=${document.documentElement.clientHeight}`
  ].join(' ')
}

/**
 * 记一条带快照的读数，并把最近若干条通过原生桥接送到 logcat。
 *
 * 每次只送"最后若干条"而不是全部：logcat 一行一条，40 条足够看出振荡周期，
 * 又不会把日志刷到看不清。桥接不存在时（浏览器里跑）只留在内存缓冲。
 */
export function reportDiag(line: string): void {
  recordDiag(line)
  if (typeof window === 'undefined') return
  const bridge = (window as unknown as { MikiDiag?: { log?: (text: string) => void } }).MikiDiag
  if (!bridge || typeof bridge.log !== 'function') return
  try {
    bridge.log(diagBuffer().join(' | '))
  } catch {
    // 桥接调用失败不影响页面（排查工具，不能因为它把主流程带崩）
  }
}
