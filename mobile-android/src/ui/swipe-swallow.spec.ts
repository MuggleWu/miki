// 手势结束后"吞一次点击"的三个不变量。第二条是回归：真机上删完卡第一次点按被吞掉，
// 原因就是"只吞不解除"——手势没补发 click 时这个状态会一直挂着。
import { describe, expect, it } from 'vitest'
import { createClickSwallower, SWALLOW_CLICK_MS } from './swipe-swallow'

describe('createClickSwallower', () => {
  it('手势刚结束时补发的 click 吞掉一次，第二次就放行', () => {
    const s = createClickSwallower()
    s.suppress(1000)
    expect(s.shouldSwallow(1010)).toBe(true) // 浏览器补发的那一次
    expect(s.shouldSwallow(1020)).toBe(false) // 用户真实的下一次点按
  })

  it('新的触摸开始 → 之前的吞掉状态立即作废（删完卡能立刻点下一张）', () => {
    const s = createClickSwallower()
    s.suppress(1000)
    s.release() // 手指再次按下
    expect(s.shouldSwallow(1005)).toBe(false)
  })

  it('超过时间窗就不再吞（没有补发 click 时不留下悬挂状态）', () => {
    const s = createClickSwallower()
    s.suppress(1000)
    expect(s.shouldSwallow(1000 + SWALLOW_CLICK_MS)).toBe(false)
    expect(s.shouldSwallow(1000 + SWALLOW_CLICK_MS + 10)).toBe(false)
  })
})
