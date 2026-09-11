// 左边缘右滑唤出抽屉（Android 上的标准手势）。
//
// 为什么不用 CSS/浏览器手势：WebView 里没有原生抽屉手势，只能自己从触摸事件里判。
// 判定规则在 edge-swipe.ts（纯函数、有单测），这里只负责接事件与决定"当前能不能开"。
import { useEffect } from 'react'
import { useApp } from './store'
import { shouldOpenDrawer, type Point } from './edge-swipe'

export function useEdgeSwipeDrawer(): void {
  useEffect(() => {
    let start: Point | null = null

    const canOpen = (): boolean => {
      const { route, drawerOpen } = useApp.getState()
      // 学习页是"专注屏"，边缘滑动在这里只会打断刷卡；弹层（弹窗/表单）打开时不接管，
      // 免得两层手势互相打架
      if (drawerOpen || route.kind === 'study') return false
      return !document.querySelector('dialog[open]')
    }

    const onStart = (e: TouchEvent): void => {
      start = null
      if (e.touches.length !== 1 || !canOpen()) return
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY }
    }

    const onMove = (e: TouchEvent): void => {
      if (!start || e.touches.length !== 1) return
      const now = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      if (shouldOpenDrawer(start, now, true)) {
        start = null
        useApp.getState().setDrawer(true)
      }
    }

    const onEnd = (): void => {
      start = null
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
