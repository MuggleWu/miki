// 拖动计数自愈单测。
//
// 原缺陷：activeDrags 只在 mouseup 里自减，mouseup 丢失（拖到窗口外松手、被系统弹窗
// 抢走鼠标、拖动中失焦）后计数永久 > 0 → isDragResizing() 恒为真 → 表头点击排序被
// 永久忽略（Browser.tsx onHeaderClick 直接 return），用户完全看不出原因。
// 模块级状态，故 jsdom 环境 + 每例复位。
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dragAxis, isDragResizing, resetDragStateForTest } from '../components/drag'

/** 造一个最小的 React.MouseEvent（dragAxis 只读 clientX/clientY） */
const mouseEvent = (x: number, y = 0) => ({ clientX: x, clientY: y }) as React.MouseEvent

const drag = (from: number) => dragAxis(mouseEvent(from), 'x', onMove)
let onMove: ReturnType<typeof vi.fn>

/** 让 setTimeout(…, 0) 的延迟自减落地 */
const flushTimers = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  resetDragStateForTest()
  onMove = vi.fn()
})

describe('拖动计数', () => {
  it('拖动期间为真，mouseup 后归零', async () => {
    drag(100)
    expect(isDragResizing()).toBe(true)
    window.dispatchEvent(new MouseEvent('mouseup'))
    // 归零是延迟的：要覆盖 mouseup 之后同步派发的那个 click
    expect(isDragResizing()).toBe(true)
    await flushTimers()
    expect(isDragResizing()).toBe(false)
  })

  it('拖动中移动会按位移回调', () => {
    drag(100)
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 130 }))
    expect(onMove).toHaveBeenCalledWith(30)
  })

  it('mouseup 丢失后计数不会永久挂住（拖到窗口外松手也不会废掉表头排序）', async () => {
    // 关键序列：拖动中窗口失焦/鼠标移出窗口 → mouseup 永远到不了。
    // 旧实现只在 mouseup 里自减，没有任何补结算路径，于是计数永久 > 0，
    // isDragResizing() 恒为真、表头点击排序被永久忽略（Browser onHeaderClick 直接 return）。
    drag(100)
    await flushTimers()
    await flushTimers()
    expect(isDragResizing()).toBe(true) // 拖动态本身是对的

    // 用户接着正常拖一次列宽并松手：计数必须回到 0
    drag(200)
    window.dispatchEvent(new MouseEvent('mouseup'))
    await flushTimers()
    expect(isDragResizing()).toBe(false) // 上一次的泄漏被这次拖动开始前补结算 + 本次 mouseup

    // 再正常拖一次，确认没有残留（既不多减成负数导致提前放行，也不残留）
    drag(300)
    expect(isDragResizing()).toBe(true)
    window.dispatchEvent(new MouseEvent('mouseup'))
    await flushTimers()
    expect(isDragResizing()).toBe(false)
  })

  it('计数残留时点表头仍能排序（这才是用户遇到的实际路径）', async () => {
    // 丢 mouseup 之后，用户下一步通常是直接点表头排序——不能要求他「先再拖一次」。
    // 从拖动结束到他点表头必然经过一段时间，所以陈旧的残留不能再屏蔽排序。
    // 用 fake timers 直接把时钟推过 STALE 窗口（本文件其余用例要真计时器，这里局部开）
    vi.useFakeTimers()
    try {
      drag(100)
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 140 })) // 真的移动过
      expect(isDragResizing()).toBe(true)
      vi.advanceTimersByTime(2000) // 用户这时才去点表头
      expect(isDragResizing()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('按住不放（还没移动）也算拖动中：收尾 click 要屏蔽', () => {
    // 反向约束：只按下滑块还没拖动时，那次 click 仍属拖动，不能放行成排序
    drag(100)
    expect(isDragResizing()).toBe(true)
  })

  it('拖动刚结束那一下的 click 仍被跳过（排序不会误触发）', async () => {
    // 反向约束：真正的拖动收尾 click 必须继续被屏蔽，否则拖列宽会顺手把排序也改了
    drag(100)
    await flushTimers()
    expect(isDragResizing()).toBe(true) // 计数还挂着且刚刚才移动过
  })

  it('窗口失焦也结算（异常中断不会让计数永久泄漏）', async () => {
    drag(100)
    expect(isDragResizing()).toBe(true)
    window.dispatchEvent(new Event('blur'))
    await flushTimers()
    expect(isDragResizing()).toBe(false)
  })

  it('重复结算只减一次（mouseup 后再 blur 不会把计数减成负数）', async () => {
    drag(100)
    window.dispatchEvent(new MouseEvent('mouseup'))
    window.dispatchEvent(new Event('blur'))
    await flushTimers()
    expect(isDragResizing()).toBe(false)
    // 若多减了一次，activeDrags 变 -1 → isDragResizing 仍为 false，但下一次拖动
    // 会立刻「看起来已归零」而放行排序点击——用两次连续拖动钉住
    drag(300)
    window.dispatchEvent(new MouseEvent('mouseup'))
    await flushTimers()
    expect(isDragResizing()).toBe(false)
  })

  it('结算后不再响应移动（监听已摘掉）', async () => {
    drag(100)
    window.dispatchEvent(new MouseEvent('mouseup'))
    await flushTimers()
    onMove.mockClear()
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 500 }))
    expect(onMove).not.toHaveBeenCalled()
  })
})
