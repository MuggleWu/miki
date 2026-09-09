// 统计（T 域）：全部/某牌组 × 近一年/全部，五板块
import { useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts'
import { sortedDecks, useApp } from '../store'
import { createSeqGuard } from '../staleGuard'
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
  const dataEpoch = useApp((s) => s.dataEpoch)
  const [deckId, setDeckId] = useState<string | null>(null)
  const [range, setRange] = useState<'year' | 'all'>('year')
  const [stats, setStats] = useState<StatsPayload | null>(null)
  // 竞态防护：快速切换牌组/范围时旧响应晚到不得覆盖图表
  const seqRef = useRef(createSeqGuard())

  useEffect(() => {
    const seq = seqRef.current.next()
    void window.miki.getStats({ deckId, range }).then((s) => {
      if (seqRef.current.isLatest(seq)) setStats(s)
    })
  }, [deckId, range, dataEpoch])

  const dark = theme === 'dark'
  // 深色 = Darcula 色板（与 styles.css [data-theme='dark'] 保持一致；canvas 读不到 CSS 变量，只能同步硬编码）
  const dim = dark ? '#808080' : '#7a7e8a'
  const split = dark ? '#43494a' : '#dcdfe6'
  const accent = dark ? '#589df6' : '#4f6fe0'
  const okColor = dark ? '#6faf6e' : '#2f9e6a'
  const dangerColor = dark ? '#ff6b68' : '#d5405a'
  const warnColor = dark ? '#e0a555' : '#b97a1e'
  const fg = dark ? '#a9b7c6' : '#1f2126'
  const chartBg = { backgroundColor: 'transparent', textStyle: { color: fg } }
  const AXIS = { axisLabel: { color: dim }, splitLine: { lineStyle: { color: split } } }
  const TOOLTIP = { backgroundColor: dark ? '#3c3f41' : '#ffffff', borderColor: split, textStyle: { color: fg } }

  const forecastOption: echarts.EChartsOption | null = stats && {
    ...chartBg,
    grid: { left: 40, right: 16, top: 20, bottom: 28 },
    xAxis: { type: 'category', data: stats.forecast.map((f) => f.label), ...AXIS },
    yAxis: { type: 'value', ...AXIS },
    series: [{ type: 'bar', data: stats.forecast.map((f) => f.count), itemStyle: { color: accent }, barCategoryGap: '30%' }],
    tooltip: {
      trigger: 'axis',
      ...TOOLTIP,
      formatter: (ps: unknown) => {
        const p = (ps as { dataIndex: number }[]) [0]
        const f = stats.forecast[p.dataIndex]
        return `${f.range}<br/>${f.count} 张`
      }
    }
  }

  const heatmapOption: echarts.EChartsOption | null = stats && range === 'year' ? {
    ...chartBg,
    visualMap: {
      min: 0,
      max: 60,
      show: false,
      // GitHub 式四档色阶，高色阶取 accent 蓝；空档接近背景色
      inRange: { color: dark ? ['#333333', '#28497c', '#3f74c4', '#589df6'] : ['#e9ebf0', '#a8b8f0', '#6f8cff', '#3f55c0'] }
    },
    calendar: {
      range: [stats.heatmap[0]?.date, stats.heatmap[stats.heatmap.length - 1]?.date],
      cellSize: ['auto', 14],
      // GitHub 风格：格间缝隙用页面底色描边形成，关闭月份边界线
      itemStyle: {
        color: dark ? '#333333' : '#e9ebf0',
        borderColor: dark ? '#2b2b2b' : '#f5f6f8',
        borderWidth: 2,
        borderRadius: 2
      },
      splitLine: { show: false },
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
          {sortedDecks(decks).map((d) => (
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
