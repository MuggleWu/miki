// 抽屉开合的竞态回归测试。
//
// 背景：入场动画要"先停在屏外、下一帧再滑到位"（双 rAF）。最初的判断"期间有没有被手势接管"
// 用的是哨兵值——偏移是否还等于 -width。但**关闭吸附的目标值也是 -width**，两者会撞上：
// settle 把偏移设成 -width 之后双 rAF 才跑到，哨兵正好成立，于是它把偏移改成 0（全开），
// 而 settle 的收尾又因为偏移已被改掉而放弃关闭——表现出来是"轻轻一甩本该关闭，抽屉反而弹开"。
// 现在用自增代号（enterSeq）作废过期的回调，这几条测试就是钉住它。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp } from './store'

const W = 320
/** store 里的偏移（0 = 全开，-W = 全收） */
const drag = (): number | null => useApp.getState().drawerDrag

describe('抽屉入场与吸附', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // 让 rAF 也走假时钟，双 rAF + 收尾超时都能被推着跑完
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16))
    useApp.setState({
      drawerOpen: false,
      drawerDrag: null,
      drawerDragging: false,
      drawerWidth: W,
      enterSeq: 0
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('点汉堡打开：先停在屏外，再滑到位，最后把偏移交还 CSS', () => {
    useApp.getState().setDrawer(true)
    expect(drag()).toBe(-W) // 起点在屏幕外（过渡才有起点）
    vi.advanceTimersByTime(50) // 双 rAF 跑完
    expect(drag()).toBe(0)
    vi.advanceTimersByTime(400)
    expect(drag()).toBe(null)
    expect(useApp.getState().drawerOpen).toBe(true)
  })

  it('轻轻一甩本该关闭时，过期的入场回调不能把抽屉又弹开', () => {
    const s = useApp.getState()
    s.setDrawer(true) // 手势起手：挂上抽屉，同时排下双 rAF
    s.setDrawerDrag(-312) // 手指跟到 -312（只走了 8px）
    s.settleDrawer({ velocity: 0, travelled: 8 }) // 位移太小 → 按位置判定：关闭
    vi.advanceTimersByTime(1000) // rAF 与收尾都跑完
    expect(useApp.getState().drawerOpen).toBe(false)
    expect(drag()).toBe(null)
  })

  it('轻扫：位移远不到半宽，但甩得够快 → 打开', () => {
    const s = useApp.getState()
    s.setDrawer(true)
    s.setDrawerDrag(-260) // 只走了 60px
    s.settleDrawer({ velocity: 0.8, travelled: 60 })
    vi.advanceTimersByTime(1000)
    expect(useApp.getState().drawerOpen).toBe(true)
    expect(drag()).toBe(null)
  })

  it('轻扫反方向：全开时往左轻甩 → 关闭', () => {
    const s = useApp.getState()
    s.setDrawer(true)
    vi.advanceTimersByTime(400) // 先正常打开
    s.setDrawerDrag(-72) // 手指往左跟到 -72
    s.settleDrawer({ velocity: -0.8, travelled: 72 })
    vi.advanceTimersByTime(1000)
    expect(useApp.getState().drawerOpen).toBe(false)
  })

  it('慢拖没过半：留在关闭（速度不够时不按方向判）', () => {
    const s = useApp.getState()
    s.setDrawer(true)
    s.setDrawerDrag(-260)
    s.settleDrawer({ velocity: 0.05, travelled: 60 })
    vi.advanceTimersByTime(1000)
    expect(useApp.getState().drawerOpen).toBe(false)
  })
})
