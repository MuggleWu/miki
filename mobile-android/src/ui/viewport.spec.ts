// 键盘高度怎么算（纯函数单测 + 模拟开关的行为用例）。
//
// 为什么值得单测：这段判断原来内联在 App 的 effect 里，错一次就得在真机上试一次，
// 而真机验证的成本极高（装包、连数据线、看 logcat）。抽出来之后，几种真实情形可以在
// node 里逐个钉住——尤其是"布局视口不缩"这一格：Android 15+ 边到边下 adjustResize 失效，
// 窗口不随键盘收缩，网页只能靠可视视口自己算，算错的表现就是"键盘盖住正在打的字"。
//
// 环境用 jsdom：原生侧是通过 window 上的 miki:insets 事件通知网页重算的（见 MainActivity），
// 那条路径要真的派发一次事件才算验过，node 环境里没有 window。
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  keyboardHeight,
  nativeKeyboardHeight,
  readMetrics,
  watchKeyboardHeight,
  type ViewportEnv,
  type VisualViewportLike
} from './viewport'

describe('keyboardHeight：键盘占掉多高', () => {
  it('边到边（布局视口不缩）：键盘高度 = 布局视口 − 可见区底部', () => {
    // 真机量过的形状：屏 852，键盘 300 时 vv.height 掉到 552
    expect(keyboardHeight({ layoutHeight: 852, visualHeight: 552, visualOffsetTop: 0, scale: 1 })).toBe(300)
  })

  it('浏览器为露出输入框把可视区往下滚过（offsetTop > 0）：不能把它算成键盘高度', () => {
    // vv.height=552、offsetTop=40 → 可见区底 = 592，被遮住的是 852−592=260 而不是 300。
    // 只减 vv.height 会得到 300，多留 40px 白（弹层整体上移、底部空一截）
    expect(keyboardHeight({ layoutHeight: 852, visualHeight: 552, visualOffsetTop: 40, scale: 1 })).toBe(260)
  })

  it('老系统（窗口随键盘收缩）：布局视口已经变小，算出来是 0——不能再补一层白', () => {
    // Android 14 及以下 adjustResize 生效时的读数：两者一起缩
    expect(keyboardHeight({ layoutHeight: 552, visualHeight: 552, visualOffsetTop: 0, scale: 1 })).toBe(0)
    // 原生把 WebView 顶上去之后也是这个形状（MainActivity 让位成功后不该叠加）
    expect(keyboardHeight({ layoutHeight: 552, visualHeight: 552, visualOffsetTop: 0, scale: 1 })).toBe(0)
  })

  it('没键盘时不出现负值', () => {
    expect(keyboardHeight({ layoutHeight: 852, visualHeight: 900, visualOffsetTop: 0, scale: 1 })).toBe(0)
  })

  it('缩放不是 1 时按布局坐标折算', () => {
    // 双指放大到 2 倍：可见视口高度是 CSS 像素，折算到布局坐标要乘 scale
    expect(keyboardHeight({ layoutHeight: 852, visualHeight: 276, visualOffsetTop: 0, scale: 2 })).toBe(300)
  })

  it('数值离谱时封顶（超过屏高七成一定是量错了）', () => {
    // 例如把 vv.height=0（某些 WebView 在切换瞬间会给 0）当成"键盘占满全屏"
    expect(keyboardHeight({ layoutHeight: 852, visualHeight: 0, visualOffsetTop: 0, scale: 1 })).toBe(596)
  })
})

/** 只实现 watchKeyboardHeight 用到的那几个成员 */
class FakeVv implements VisualViewportLike {
  height: number
  offsetTop = 0
  scale = 1
  private listeners: Record<string, (() => void)[]> = {}

  constructor(height: number) {
    this.height = height
  }

  addEventListener(type: string, fn: () => void): void {
    ;(this.listeners[type] ??= []).push(fn)
  }

  removeEventListener(type: string, fn: () => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn)
  }

  emit(type: string): void {
    for (const fn of [...(this.listeners[type] ?? [])]) fn()
  }

  listenerCount(): number {
    return Object.values(this.listeners).reduce((n, l) => n + l.length, 0)
  }
}

function envWith(vv: FakeVv | null, layoutHeight = 852, nativeKb = 0): ViewportEnv {
  return { layoutHeight: () => layoutHeight, visualViewport: () => vv, nativeKeyboardHeight: () => nativeKb }
}

describe('watchKeyboardHeight：跟着可视视口变化', () => {
  it('立即算一次，之后只在键盘高度真的变了才回调', () => {
    const vv = new FakeVv(852)
    const seen: number[] = []
    watchKeyboardHeight({ env: envWith(vv), onChange: (kb) => seen.push(kb), log: false })
    expect(seen).toEqual([0])
    vv.height = 552
    vv.emit('resize')
    expect(seen).toEqual([0, 300])
    vv.emit('scroll') // 高度没变 → 不重复回调（写 CSS 变量是白干活）
    expect(seen).toEqual([0, 300])
    vv.height = 852
    vv.emit('resize')
    expect(seen).toEqual([0, 300, 0])
  })

  it('取消后不再回调，也不再占着监听', () => {
    const vv = new FakeVv(852)
    const seen: number[] = []
    const stop = watchKeyboardHeight({ env: envWith(vv), onChange: (kb) => seen.push(kb), log: false })
    expect(vv.listenerCount()).toBe(2)
    stop()
    expect(vv.listenerCount()).toBe(0)
    vv.height = 552
    vv.emit('resize')
    expect(seen).toEqual([0])
  })

  // 真机回归：原生按键盘高度把 WebView 顶上去之后（--native-kb 有值），网页侧必须报 0。
  // 早先这里照样按可视视口算，于是"原生顶一次 + 网页再让一次"，两层还会互相触发回调，
  // 键盘弹出期间内容在两三个位置之间反复跳。让位只留原生那一层。
  it('原生已接管键盘（--native-kb 有值）：网页侧报 0，不重复让位', () => {
    // 关键：这幅读数下网页侧自己算会得到 300（布局视口 852、可见区底 552），而原生同时报了
    // 300 的 --native-kb，正确结果是 0。断言必须能区分"报 0"和"报 300"——否则用例恒真
    // （第一版就写错了：给的可视区读数让两边都算成 0，变异测试没抓住这个 bug）。
    const vv = new FakeVv(552)
    const seen: number[] = []
    const env = envWith(vv, 852, 300)
    expect(keyboardHeight(readMetrics(env))).toBe(300) // 先证明"没有原生接管时会算成 300"
    watchKeyboardHeight({ env, onChange: (kb) => seen.push(kb), log: false })
    expect(seen).toEqual([0])
  })

  it('--native-kb 有值时 browserEnv 能读到真值（原生与网页的接线）', () => {
    document.documentElement.style.setProperty('--native-kb', '280px')
    try {
      expect(nativeKeyboardHeight()).toBe(280)
      document.documentElement.style.removeProperty('--native-kb')
      expect(nativeKeyboardHeight()).toBe(0)
    } finally {
      document.documentElement.style.removeProperty('--native-kb')
    }
  })

  it('原生接管/交还时，可视区没变化也要重算（靠 miki:insets 事件）', () => {
    const vv = new FakeVv(852)
    let native = 0
    const seen: number[] = []
    watchKeyboardHeight({
      env: { layoutHeight: () => 852, visualViewport: () => vv, nativeKeyboardHeight: () => native },
      onChange: (kb) => seen.push(kb),
      log: false
    })
    expect(seen).toEqual([0])
    // 键盘弹起：原生先接管（写 --native-kb 后派发事件）。可视区读数这时还没变，
    // 重算结果仍是 0（原生在让位）——不能因为"没变化"就漏掉这次重算。
    native = 300
    window.dispatchEvent(new Event('miki:insets'))
    expect(seen).toEqual([0])
    // 原生交还（比如键盘收起前先把内边距清了）：这次网页侧要接管，同样只靠事件驱动
    native = 0
    vv.height = 552
    window.dispatchEvent(new Event('miki:insets'))
    expect(seen).toEqual([0, 300])
  })

  it('没有 visualViewport 的旧 WebView：不炸，也不写这个变量（由 CSS 的默认值兜底）', () => {
    const seen: number[] = []
    const stop = watchKeyboardHeight({ env: envWith(null), onChange: (kb) => seen.push(kb), log: false })
    expect(seen).toEqual([])
    expect(() => stop()).not.toThrow()
  })
})

describe('readMetrics：模拟开关（浏览器里复现键盘）', () => {
  it('没有开关时用真实读数', () => {
    const vv = new FakeVv(852)
    const m = readMetrics(envWith(vv))
    expect(m).toEqual({ layoutHeight: 852, visualHeight: 852, visualOffsetTop: 0, scale: 1 })
  })

  it('设了 __mikiKbOverride 就按它算（真机状态在浏览器里可复现）', () => {
    const vv = new FakeVv(852)
    vv.scale = 1
    ;(globalThis as unknown as { window?: unknown }).window = { __mikiKbOverride: { height: 552, offsetTop: 12 } }
    try {
      const m = readMetrics(envWith(vv))
      expect(keyboardHeight(m)).toBe(288) // 852 − (552 + 12)
    } finally {
      delete (globalThis as unknown as { window?: unknown }).window
    }
  })
})
