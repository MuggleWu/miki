// 抽屉手势：从/关闭状态/左边缘拉出，在打开状态下左拖收回，全程跟手。
//
// 判定规则在 edge-swipe.ts（纯函数、有单测），这里只负责接事件、维护一次拖动的状态机，
// 以及把偏移写进 store（Drawer 组件照着它渲染 transform）。
//
// 为什么用触摸事件而不是 CSS 手势：WebView 里没有现成的侧滑抽屉手势，也没法用
// 纯 CSS 表达"跟手 + 松手吸附"，只能自己算。
import { useEffect } from 'react'
import { useApp } from './store'
import { dragAxis, dragOffsetFromClosed, dragOffsetFromOpen, inEdgeZone, type Point } from './edge-swipe'

/** 与 styles.css 里 .drawer 的 width 保持一致；抽屉挂载后会实测覆盖 */
export function drawerWidth(): number {
  return Math.min(window.innerWidth * 0.78, 320)
}

export function useEdgeSwipeDrawer(): void {
  useEffect(() => {
    let start: Point | null = null
    /** undecided = 还不知道是拖抽屉还是滚页面；其余表示已经决定了 */
    let mode: 'undecided' | 'open' | 'closing' | 'aborted' | null = null
    let fromOpen = false

    const reset = (): void => {
      start = null
      mode = null
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
    }

    const onMove = (e: TouchEvent): void => {
      if (!start || mode === null || mode === 'aborted') return
      if (e.touches.length !== 1) {
        reset()
        return
      }
      const now = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      const st = useApp.getState()

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

    const onEnd = (): void => {
      const decided = mode === 'open' || mode === 'closing'
      reset()
      if (decided) useApp.getState().settleDrawer()
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
