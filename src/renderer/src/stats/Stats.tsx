// 统计（T 域）：全部/某牌组 × 近一年/全部，五板块
import { useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts'
import { useApp } from '../store'
import type { StatsPayload } from '../../../shared/types'

function Chart(props: { option: echarts.EChartsOption }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current) return
    const chart = echarts.init(ref.current)
    chart.setOption(props.option)
    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(ref.current)
    return () => {
      ro.disconnect()
      chart.dispose()
    }
  }, [props.option])
  return <div ref={ref} className="chart" />
}

export function Stats() {
  const decks = useApp((s) => s.decks)
  const theme = useApp((s) => s.config?.theme ?? 'light')
  const [deckId, setDeckId] = useState<string | null>(null)
  const [range, setRange] = useState<'year' | 'all'>('year')
  const [stats, setStats] = useState<StatsPayload | null>(null)

  useEffect(() => {
    void window.miki.getStats({ deckId, range }).then(setStats)
  }, [deckId, range])

  const dark = theme === 'dark'
  const dim = dark ? '#9a9aa6' : '#7a7e8a'
  const split = dark ? '#26262f' : '#dcdfe6'
  const accent = dark ? '#6f8cff' : '#4f6fe0'
  const okColor = dark ? '#3fb984' : '#2f9e6a'
  const dangerColor = dark ? '#e0556a' : '#d5405a'
  const warnColor = dark ? '#e0a555' : '#b97a1e'
  const fg = dark ? '#e8e8ee' : '#1f2126'
  const chartBg = { backgroundColor: 'transparent', textStyle: { color: fg } }
  const AXIS = { axisLabel: { color: dim }, splitLine: { lineStyle: { color: split } } }
  const TOOLTIP = { backgroundColor: dark ? '#26262f' : '#ffffff', borderColor: split, textStyle: { color: fg } }

  const forecastOption: echarts.EChartsOption | null = stats && {
    ...chartBg,
    grid: { left: 40, right: 16, top: 20, bottom: 28 },
    xAxis: { type: 'category', data: stats.forecast.map((f) => f.label), ...AXIS },
    yAxis: { type: 'value', ...AXIS },
    series: [{ type: 'bar', data: stats.forecast.map((f) => f.count), itemStyle: { color: accent }, barCategoryGap: '30%' }],
    tooltip: { trigger: 'axis', ...TOOLTIP }
  }

  const heatmapOption: echarts.EChartsOption | null = stats && range === 'year' ? {
    ...chartBg,
    visualMap: {
      min: 0,
      max: 60,
      show: false,
      inRange: { color: [dark ? '#1e1e26' : '#e8eaef', '#4f6fe0', '#8b6ff0', '#c3b3ff'] }
    },
    calendar: {
      range: [stats.heatmap[0]?.date, stats.heatmap[stats.heatmap.length - 1]?.date],
      cellSize: ['auto', 14],
      itemStyle: { color: dark ? '#17171d' : '#ffffff', borderColor: dark ? '#101014' : '#e2e5ea' },
      yearLabel: { show: false },
      monthLabel: { color: dim },
      dayLabel: { color: dim, nameMap: 'ZH' }
    },
    series: [{ type: 'heatmap', coordinateSystem: 'calendar', data: stats.heatmap.map((h) => [h.date, h.count]) }],
    tooltip: { ...TOOLTIP, formatter: (p: unknown) => String((p as { value: [string, number] }).value[1]) + ' 张' }
  } : null

  const reviewsOption: echarts.EChartsOption | null = stats && {
    ...chartBg,
    grid: { left: 40, right: 16, top: 20, bottom: 28 },
    xAxis: { type: 'category', data: stats.reviews.map((r) => r.label.slice(5)), ...AXIS },
    yAxis: { type: 'value', ...AXIS },
    series: [
      { type: 'bar', name: '答题', data: stats.reviews.map((r) => r.total), itemStyle: { color: okColor }, barCategoryGap: '30%' },
      { type: 'bar', name: '重来', data: stats.reviews.map((r) => r.again), itemStyle: { color: dangerColor }, barCategoryGap: '30%' }
    ],
    tooltip: { trigger: 'axis', ...TOOLTIP }
  }

  const stateOption: echarts.EChartsOption | null = stats && {
    ...chartBg,
    tooltip: { ...TOOLTIP },
    series: [
      {
        type: 'pie',
        radius: ['45%', '72%'],
        label: { color: fg, formatter: '{b}\n{@c}' },
        data: [
          { name: '未学习', value: stats.stateCounts.new, itemStyle: { color: accent } },
          { name: '学习中', value: stats.stateCounts.learning, itemStyle: { color: warnColor } },
          { name: '待复习', value: stats.stateCounts.review, itemStyle: { color: okColor } }
        ]
      }
    ]
  }

  const intervalOption: echarts.EChartsOption | null = stats && {
    ...chartBg,
    grid: { left: 40, right: 16, top: 20, bottom: 28 },
    xAxis: { type: 'category', data: stats.intervals.map((i) => i.bucket), ...AXIS },
    yAxis: { type: 'value', ...AXIS },
    series: [{ type: 'bar', data: stats.intervals.map((i) => i.count), itemStyle: { color: warnColor }, barCategoryGap: '30%' }],
    tooltip: { trigger: 'axis', ...TOOLTIP }
  }

  return (
    <div className="stats">
      <div className="stats-toolbar">
        <select value={deckId ?? ''} onChange={(e) => setDeckId(e.target.value || null)}>
          <option value="">全部牌组</option>
          {decks.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <select value={range} onChange={(e) => setRange(e.target.value as 'year' | 'all')}>
          <option value="year">近一年</option>
          <option value="all">全部</option>
        </select>
      </div>

      {range === 'year' && heatmapOption && (
        <div className="chart-card">
          <h4>热力图</h4>
          <Chart option={heatmapOption} />
        </div>
      )}

      <div className="chart-card">
        <h4>预测（未来到期）</h4>
        {forecastOption && <Chart option={forecastOption} />}
      </div>

      <div className="chart-card">
        <h4>复习（{range === 'year' ? '按天' : '按月'}）</h4>
        {reviewsOption && <Chart option={reviewsOption} />}
      </div>

      <div className="grid2">
        <div className="chart-card">
          <h4>卡片数量</h4>
          {stateOption && <Chart option={stateOption} />}
        </div>
        <div className="chart-card">
          <h4>复习间隔</h4>
          {intervalOption && <Chart option={intervalOption} />}
        </div>
      </div>
    </div>
  )
}
