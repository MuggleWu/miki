// 键盘挡住内容这件事，网页侧怎么算、怎么让位。
//
// 背景（Android 15+ 起，targetSdk 35+ 强制边到边）：窗口不再随输入法收缩，
// `windowSoftInputMode="adjustResize"` 那套在边到边窗口上等于失效——键盘是**画在内容之上**的，
// 而且 WebView 不会把聚焦的输入框滚进可见区。表现出来就是：点开输入框，正在打的字被键盘压住，
// 什么都看不见（真机上报的正是这条）。
//
// 网页侧能观测到的三件事各不相同，所以这里分开处理：
//
// 1. 键盘占掉了多高 → `--kb`。用布局视口底 - 可见区底，而不是"窗口高度 - 可见高度"：
//    vv.offsetTop 是可见区在布局坐标里的上沿（浏览器为露出输入框把可视区往下滚过就有值），
//    只减 vv.height 会算出一个假的键盘高度。
// 2. 底部要留多少白 → `--bottom-blocked`（CSS 里取 --kb 与安全区的大者），弹层、提示条都靠它。
// 3. 聚焦的输入框要滚进可见区 → 光靠浏览器自己的 scrollIntoView 不够（它只保证"进入滚动
//    容器"，不管键盘压住的那一条），所以滚动容器还要带 scroll-padding-bottom（见 styles.css）。
//
// 这套算法在浏览器里可验证：给 window.visualViewport 装一个替身（vite 下 __mikiKbOverride），
// 就能把"键盘弹起"这件事完整地模拟出来（见 viewport.spec.ts 与本次提交的自测记录）。
// 真机上还有一层原生兜底：MainActivity 按输入法内边距把 WebView 顶上去（它把父视图撑高、
// WebView 真的变短，fixed 元素与滚动都自然跟着走）。**让位只留这一层**：原生一接管，
// 这里就把 --kb 报成 0（判据是它注入的 --native-kb）。两层都动手会互相触发回调，
// 页面在键盘弹出期间会反复跳——真机上报的"内容一直在闪"就是这么来的。

import { insetSnapshot, reportDiag } from '@mobile/diag'

/** 键盘高度上限：屏幕顶多被键盘占掉大半，超过这个数一定是量错了（比如把缩放算错） */
const MAX_KEYBOARD_RATIO = 0.7

export interface ViewportMetrics {
  /** 布局视口高度（documentElement.clientHeight）：fixed 定位的参照，边到边下不随键盘变 */
  layoutHeight: number
  /** 可见视口高度（visualViewport.height）：键盘弹起时变小 */
  visualHeight: number
  /** 可见区在布局坐标里的上沿（visualViewport.offsetTop） */
  visualOffsetTop: number
  /** 缩放（visualViewport.scale）：非 1 时可见高度要按布局坐标折算 */
  scale: number
}

/**
 * 键盘占掉的高度（CSS 像素，>= 0）。
 *
 * 为什么把公式抽出来：这段判断原来内联在 App 的 effect 里，改一次就得在真机上试一次；
 * 抽成纯函数后可以在 node 里把「边到边（布局视口不缩）」「老系统（窗口随键盘缩）」
 * 「浏览器为露出输入框把可视区滚下去」这几种情形逐个钉住。
 */
export function keyboardHeight(m: ViewportMetrics): number {
  const scale = m.scale > 0 ? m.scale : 1
  const visibleBottom = m.visualHeight * scale + m.visualOffsetTop
  const raw = m.layoutHeight - visibleBottom
  const max = m.layoutHeight * MAX_KEYBOARD_RATIO
  return Math.round(Math.min(Math.max(raw, 0), max))
}

/** 要监听的可视区对象（visualViewport 在旧 WebView / node 里可能不存在） */
export interface VisualViewportLike {
  height: number
  offsetTop: number
  scale: number
  addEventListener(type: string, fn: () => void): void
  removeEventListener(type: string, fn: () => void): void
}

export interface ViewportEnv {
  /** 布局视口高度：documentElement.clientHeight */
  layoutHeight(): number
  /** 可见视口；没有这个 API 时返回 null（老 WebView） */
  visualViewport(): VisualViewportLike | null
  /** 原生是否已按键盘高度把 WebView 顶上去（见 nativeKeyboardHeight） */
  nativeKeyboardHeight(): number
}

/**
 * 原生是否正在负责键盘让位（MainActivity 注入的 --native-kb）。
 *
 * 为什么需要这个信号：原生让位之后 WebView 本身就短了，网页侧再按可视视口算一遍就会
 * **顶两次**；更要命的是两层同时改布局会互相触发对方的回调，键盘弹出期间页面在两三个
 * 位置之间来回跳（真机上报的"内容一直在闪"）。让位只留一层——原生那一层（它把视口真的
 * 缩短了，fixed 元素与滚动都自然跟着走），网页侧在原生接管时把 --kb 归零、不再掺和。
 *
 * 这个变量是**开关**（原生侧写 '1px'）而不是键盘高度：WebView 已经被撑短了，网页侧不需要
 * 知道具体多高；写成随高度变化的数字反而会在输入法自己改高度的瞬间（候选栏出现/收起）
 * 被误判成"原生交还了"，那一下就是可见的跳动。
 *
 * 返回值只用来判断"是否 > 0"；原生没接管时是 0。
 */
export function nativeKeyboardHeight(): number {
  if (typeof document === 'undefined') return 0
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--native-kb').trim()
  if (!raw) return 0
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 由 window / document 造出默认环境；读不到就退化成"没有可视区信息" */
export function browserEnv(): ViewportEnv {
  return {
    layoutHeight: () => document.documentElement.clientHeight,
    visualViewport: () => (window.visualViewport as unknown as VisualViewportLike | undefined) ?? null,
    nativeKeyboardHeight
  }
}

/**
 * 模拟开关：vite 下可用 `window.__mikiKbOverride = { height, offsetTop }` 覆盖可视区读数，
 * 用来在浏览器里复现"键盘弹起"（真机才有的状态，桌面浏览器造不出来）。
 * 生产构建里没人会去设它，读到 undefined 就走真实读数。
 */
interface KbOverride {
  height?: number
  offsetTop?: number
}

function readOverride(): KbOverride | null {
  if (typeof window === 'undefined') return null
  const o = (window as unknown as { __mikiKbOverride?: KbOverride }).__mikiKbOverride
  return o && typeof o === 'object' ? o : null
}

/** 算一次读数（把模拟开关叠上去），供 apply 与测试共用 */
export function readMetrics(env: ViewportEnv): ViewportMetrics {
  const vv = env.visualViewport()
  const override = readOverride()
  return {
    layoutHeight: env.layoutHeight(),
    visualHeight: override?.height ?? vv?.height ?? env.layoutHeight(),
    visualOffsetTop: override?.offsetTop ?? vv?.offsetTop ?? 0,
    scale: vv?.scale ?? 1
  }
}

export interface KeyboardWatchOptions {
  env?: ViewportEnv
  /** 键盘高度变化时调用（写 --kb 与打日志由调用方决定） */
  onChange(height: number): void
  /** 是否输出诊断日志（排这类问题时靠它看 WebView 到底有没有收缩） */
  log?: boolean
}

/**
 * 开始盯键盘高度：立刻算一次，并在可视区尺寸/位置变化时重算。
 * 返回取消函数（页面卸载时调用；标签页隐藏后回前台也会重新触发一次 resize）。
 */
export function watchKeyboardHeight(opts: KeyboardWatchOptions): () => void {
  const env = opts.env ?? browserEnv()
  const vv = env.visualViewport()
  // 没有可视视口信息（老 WebView）时**不写**这个变量：CSS 里的默认值就是 0，
  // 写了反而会把上一次的高度留在一个说不准的页面上
  if (!vv) return () => {}
  let last = -1
  const apply = (): void => {
    const m = readMetrics(env)
    // 原生已经按键盘高度把 WebView 顶上去时，这里必须报 0：再报一次键盘高度就是顶两次，
    // 而且两层互相触发回调会让页面在两三个位置之间反复跳（真机上报的"一直在闪"）。
    const native = env.nativeKeyboardHeight()
    const kb = native > 0 ? 0 : keyboardHeight(m)
    if (opts.log) {
      // 排这类问题时用 adb logcat 看这一行就够了：innerHeight 与 vv.height 同步变小
      // 说明 WebView 跟着键盘收缩了（此时 kb=0 是对的，原生已经让过位）
      const line =
        `layout=${m.layoutHeight} inner=${typeof window === 'undefined' ? '?' : window.innerHeight}` +
        ` vv=${Math.round(m.visualHeight)} offset=${Math.round(m.visualOffsetTop)}` +
        ` native=${native} kb=${kb}`
      console.log(`[miki-kb] ${line}`)
      // 记进环形缓冲并同步到 logcat：键盘闪动这类现象靠"最后几十帧的读数序列"才看得出
      // 是谁在振荡，事后再连设备只能看到当下的片段（见 diag.ts 与 README 排查一节）
      reportDiag(`kb ${line} :: ${insetSnapshot()}`)
    }
    if (kb === last) return
    last = kb
    opts.onChange(kb)
  }
  apply()
  vv.addEventListener('resize', apply)
  vv.addEventListener('scroll', apply)
  // 原生接管/交还键盘是写 CSS 变量完成的，本身不产生可视区事件：它改完会派发这个事件，
  // 我们据此重算一次（见 MainActivity 注入的脚本）。node 下（纯函数单测）没有 window。
  const onNativeInsets = (): void => apply()
  const win = typeof window === 'undefined' ? null : window
  win?.addEventListener('miki:insets', onNativeInsets)
  return () => {
    vv.removeEventListener('resize', apply)
    vv.removeEventListener('scroll', apply)
    win?.removeEventListener('miki:insets', onNativeInsets)
  }
}
