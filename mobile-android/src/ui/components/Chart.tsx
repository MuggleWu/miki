// ECharts 包装：按需动态 import（约 1MB），页面关掉就 dispose。
//
// 与桌面端的两点差异（都是有意的）：
// 1. 配色从 CSS 变量读，不再硬编码第二份色板。桌面端注释里写着"canvas 读不到 CSS 变量，
//    只能同步硬编码"——其实能读：getComputedStyle(document.documentElement) 就拿到了，
//    代价是主题切换时要重算（见下面 themeKey）。
// 2. 图表高度在窄屏上单独给小值：桌面端一屏放两张图，手机上一屏放一张才看得清刻度。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { EChartsOption, EChartsType } from 'echarts'

// type-only import 编译后不留运行时代码；运行时那份仍然靠动态 import 懒加载
let mod: Promise<typeof import('echarts')> | null = null
const loadEcharts = (): Promise<typeof import('echarts')> => (mod ??= import('echarts'))

export interface ChartPalette {
  fg: string
  dim: string
  split: string
  accent: string
  ok: string
  danger: string
  warn: string
}

/** 从 CSS 变量取图表的实际配色；变量缺失时按主题给兜底色（深色画布上配浅色文字） */
function readPalette(theme: string): ChartPalette {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, light: string, dark: string): string =>
    cs.getPropertyValue(name).trim() || (theme === 'dark' ? dark : light)
  return {
    fg: v('--fg', '#1c1c1e', '#e8e8ea'),
    dim: v('--muted', '#6b7280', '#9ca3af'),
    split: v('--line', '#e5e7eb', '#2a2d33'),
    accent: v('--accent', '#2563eb', '#60a5fa'),
    ok: v('--pass', '#16a34a', '#4ade80'),
    danger: v('--fail', '#dc2626', '#f87171'),
    warn: v('--r2', '#d97706', '#fbbf24')
  }
}

export function useChartPalette(): ChartPalette {
  // 订阅主题属性：切换深浅色时让图表配色跟着重算。
  // 用 MutationObserver 而不是把 theme 当 useMemo 依赖——主题来自 <html> 的属性，
  // 不是本组件的 state，硬塞进依赖数组只会被 lint 判成多余（它也确实是"外部变化"）。
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'light')
  useEffect(() => {
    const ob = new MutationObserver(() => setTheme(document.documentElement.dataset.theme ?? 'light'))
    ob.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => ob.disconnect()
  }, [])
  return useMemo(() => readPalette(theme), [theme])
}

export function Chart({ option, height = 180 }: { option: EChartsOption; height?: number }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const inst = useRef<EChartsType | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let alive = true
    if (!ref.current) return
    void loadEcharts().then((echarts) => {
      if (!alive || !ref.current) return
      inst.current = echarts.init(ref.current, undefined, { renderer: 'canvas' })
      inst.current.setOption(option)
      setReady(true)
    })
    const onResize = (): void => inst.current?.resize()
    window.addEventListener('resize', onResize)
    return () => {
      alive = false
      window.removeEventListener('resize', onResize)
      inst.current?.dispose()
      inst.current = null
    }
    // option 只用于首次绘制；后续更新走下面那个 effect（避免每次改配置都重新 init）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (ready) inst.current?.setOption(option)
  }, [option, ready])

  return <div ref={ref} className="chart" style={{ height }} />
}
