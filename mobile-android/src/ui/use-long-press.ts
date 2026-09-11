// 长按手势：桌面端的 E（编辑）在手机上没有对应键，落到「长按卡面」上。
//
// 实现要点（都是真机上会出问题的地方）：
// 1. 手指移动超过阈值就取消——滚动列表时不该触发长按。
// 2. 抬手/移出要清定时器，否则松手之后还会"迟到"地弹出编辑页。
// 3. 长按触发后要抑制随后的 tap：否则长按会先开编辑页、再被 tap 当成"显示答案"。
import { useRef, type PointerEvent as ReactPointerEvent } from 'react'

interface LongPressOptions {
  onLongPress(): void
  /** 长按判定时长；500ms 是 Android 系统级长按的标准口径 */
  delayMs?: number
  /** 移动超过这个像素数就取消 */
  moveTolerance?: number
}

export function useLongPress({ onLongPress, delayMs = 500, moveTolerance = 10 }: LongPressOptions): {
  onPointerDown(e: ReactPointerEvent): void
  onPointerMove(e: ReactPointerEvent): void
  onPointerUp(): void
  onPointerCancel(): void
  /** 供 onClick 判断：刚发生过长按就吞掉这次点击 */
  shouldSwallowClick(): boolean
} {
  const timer = useRef<number | null>(null)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)

  const clear = (): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    origin.current = null
  }

  return {
    onPointerDown(e) {
      fired.current = false
      origin.current = { x: e.clientX, y: e.clientY }
      timer.current = window.setTimeout(() => {
        fired.current = true
        origin.current = null
        timer.current = null
        onLongPress()
      }, delayMs)
    },
    onPointerMove(e) {
      const o = origin.current
      if (!o || timer.current === null) return
      if (Math.abs(e.clientX - o.x) > moveTolerance || Math.abs(e.clientY - o.y) > moveTolerance) clear()
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    shouldSwallowClick() {
      if (!fired.current) return false
      fired.current = false
      return true
    }
  }
}
