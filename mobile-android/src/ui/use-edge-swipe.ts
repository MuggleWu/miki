// 抽屉手势：从关闭状态的左边缘拉出，在打开状态下左拖收回，全程跟手；甩得够快则按方向定结果。
//
// 判定规则在 edge-swipe.ts（纯函数、有单测），这里只负责接事件、维护一次拖动的状态机、
// 记录采样以便算速度，以及把偏移写进 store（Drawer 组件照着它渲染 transform）。
//
// 为什么用触摸事件而不是 CSS 手势：WebView 里没有现成的侧滑抽屉手势，也没法用
// 纯 CSS 表达"跟手 + 松手吸附 + 甩动判定"，只能自己算。
import { useEffect } from 'react'
import { useApp } from './store'
import {
  dragAxis,
  dragOffsetFromClosed,
  dragOffsetFromOpen,
  dragVelocity,
  inEdgeZone,
  type DragSample,
  type Point
} from './edge-swipe'

/** 与 styles.css 里 .drawer 的 width 保持一致；抽屉挂载后会实测覆盖 */
export function drawerWidth(): number {
  return Math.min(window.innerWidth * 0.78, 320)
}

/** 采样只留最近这些个：速度窗口是 100ms，用不到更多 */
const MAX_SAMPLES = 8

export function useEdgeSwipeDrawer(): void {
  useEffect(() => {
    let start: Point | null = null
    /** undecided = 还不知道是拖抽屉还是滚页面；其余表示已经决定了 */
    let mode: 'undecided' | 'open' | 'closing' | 'aborted' | null = null
    let fromOpen = false
    let samples: DragSample[] = []

    const reset = (): void => {
      start = null
      mode = null
      samples = []
    }

    const pushSample = (p: Point, t: number): void => {
      samples.push({ x: p.x, t })
      if (samples.length > MAX_SAMPLES) samples.shift()
    }

    /** 手指移动了：先决定方向，再更新抽屉偏移 */
    const applyMove = (now: Point, t: number): void => {
      if (!start || mode === null || mode === 'aborted') return
      const st = useApp.getState()
      pushSample(now, t)

      if (mode === 'undecided') {
        const axis = dragAxis(start, now)
        if (axis === 'vertical') {
          mode = 'aborted' // 让页面/抽屉自己滚，不抢
          return
        }
        if (axis !== 'horizontal') return
        if (fromOpen) {
          mode = 'closing'
        } else {
          mode = 'open'
          st.setDrawer(true) // 先把抽屉挂上（此时偏移 = 全收起），后面的 move 才开始跟手
          st.setDrawerDrag(-st.drawerWidth)
        }
      }

      const width = st.drawerWidth
      const offset = fromOpen
        ? dragOffsetFromOpen(now.x - start.x, width)
        : dragOffsetFromClosed(now.x - start.x, width)
      st.setDrawerDrag(offset)
    }

    const onStart = (e: TouchEvent): void => {
      reset()
      if (e.touches.length !== 1) return
      const { drawerOpen, route } = useApp.getState()
      const target = e.target as Element | null
      const x = e.touches[0].clientX

      if (drawerOpen) {
        // 抽屉开着时：手指落在抽屉面板上才接管（点在遮罩上由遮罩自己处理关闭）
        fromOpen = !!target?.closest('.drawer')
        if (!fromOpen) return
      } else {
        // 抽屉关着时：只有学习页与弹层场景不接管，免得两层手势打架
        if (route.kind === 'study' || document.querySelector('dialog[open]')) return
        if (!inEdgeZone(x)) return
        fromOpen = false
      }
      start = { x, y: e.touches[0].clientY }
      mode = 'undecided'
      pushSample(start, e.timeStamp)
    }

    const onMove = (e: TouchEvent): void => {
      if (!start || mode === null || mode === 'aborted') return
      if (e.touches.length !== 1) {
        reset()
        return
      }
      applyMove({ x: e.touches[0].clientX, y: e.touches[0].clientY }, e.timeStamp)
    }

    const onEnd = (e: TouchEvent): void => {
      if (!start || mode === null) {
        reset()
        return
      }
      // 快速轻扫有时只送来 touchstart + touchend（中间没有 touchmove）：拿松手点补一次判定
      const t = e.changedTouches?.[0]
      if (t && mode === 'undecided') applyMove({ x: t.clientX, y: t.clientY }, e.timeStamp)

      const decided = mode === 'open' || mode === 'closing'
      const travelled = Math.abs((t?.clientX ?? start.x) - start.x)
      const velocity = dragVelocity(samples)
      reset()
      // 甩得够快就按方向定，否则按位置（过半）定——两种情况都在 settleDrawer 里落定
      if (decided) useApp.getState().settleDrawer({ velocity, travelled })
    }

    // 被动监听：这里只读坐标，不能 preventDefault，也就不会挡住页面滚动
    const opts: AddEventListenerOptions = { passive: true }
    document.addEventListener('touchstart', onStart, opts)
    document.addEventListener('touchmove', onMove, opts)
    document.addEventListener('touchend', onEnd, opts)
    document.addEventListener('touchcancel', onEnd, opts)
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', onEnd)
    }
  }, [])
}
