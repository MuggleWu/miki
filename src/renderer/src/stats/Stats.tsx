// 统计（T 域）：全部/某牌组 × 近一年/全部，六板块
import { useEffect, useRef, useState } from 'react'
import { sortedDecks, useApp } from '../store'
import { createSeqGuard } from '../staleGuard'
import type { EChartsOption, EChartsType } from 'echarts'
import type { StatsPayload } from '../../../shared/types'

// echarts 走动态 import（约 1MB）：它只被统计页用，静态 import 会让每个启动都背上这份解析成本。
// 类型仍从 'echarts' 静态引入——type-only import 编译后不留任何运行时代码。
let echartsModule: Promise<typeof import('echarts')> | null = null
const loadEcharts = () => (echartsModule ??= import('echarts'))

function Chart(props: { option: EChartsOption }) {
  const ref = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)

  // 模块到达前先占位（统计页首帧不闪空白：容器与 .chart 同高）
  useEffect(() => {
    let alive = true
    void loadEcharts().then(() => {
      if (alive) setReady(true)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!ready || !ref.current) return
    let chart: EChartsType | null = null
    let ro: ResizeObserver | null = null
    let disposed = false
    // ready 后 echarts 已就绪，同步即可（await 一次也为兼容缓存未命中）
    void loadEcharts().then((echarts) => {
      if (disposed || !ref.current) return
      chart = echarts.init(ref.current)
      chart.setOption(props.option)
      ro = new ResizeObserver(() => chart?.resize())
      ro.observe(ref.current)
    })
    return () => {
      disposed = true
      ro?.disconnect()
      chart?.dispose()
    }
  }, [props.option, ready])

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

  const forecastOption: EChartsOption | null = stats && {
    ...chartBg,
    grid: { left: 40, right: 16, top: 20, bottom: 28 },
    xAxis: { type: 'category', data: stats.forecast.map((f) => f.label), ...AXIS },
    yAxis: { type: 'value', ...AXIS },
    series: [
      { type: 'bar', data: stats.forecast.map((f) => f.count), itemStyle: { color: accent }, barCategoryGap: '30%' }
    ],
    tooltip: {
      trigger: 'axis',
      ...TOOLTIP,
      formatter: (ps: unknown) => {
        const p = (ps as { dataIndex: number }[])[0]
        const f = stats.forecast[p.dataIndex]
        return `${f.range}<br/>${f.count} 张`
      }
    }
  }

  const heatmapOption: EChartsOption | null =
    stats && range === 'year'
      ? {
          ...chartBg,
          visualMap: {
            min: 0,
            max: 60,
            show: false,
            // GitHub 式四档色阶，高色阶取 accent 蓝；空档接近背景色
            inRange: {
              color: dark ? ['#333333', '#28497c', '#3f74c4', '#589df6'] : ['#e9ebf0', '#a8b8f0', '#6f8cff', '#3f55c0']
            }
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
          series: [
            { type: 'heatmap', coordinateSystem: 'calendar', data: stats.heatmap.map((h) => [h.date, h.count]) }
          ],
          tooltip: {
            ...TOOLTIP,
            formatter: (p: unknown) => String((p as { value: [string, number] }).value[1]) + ' 张'
          }
        }
      : null

  const reviewsOption: EChartsOption | null = stats && {
    ...chartBg,
    grid: { left: 40, right: 16, top: 20, bottom: 28 },
    xAxis: { type: 'category', data: stats.reviews.map((r) => r.label.slice(5)), ...AXIS },
    yAxis: { type: 'value', ...AXIS },
    series: [
      {
        type: 'bar',
        name: '答题',
        data: stats.reviews.map((r) => r.total),
        itemStyle: { color: okColor },
        barCategoryGap: '30%'
      },
      {
        type: 'bar',
        name: '重来',
        data: stats.reviews.map((r) => r.again),
        itemStyle: { color: dangerColor },
        barCategoryGap: '30%'
      }
    ],
    tooltip: { trigger: 'axis', ...TOOLTIP }
  }

  const stateOption: EChartsOption | null = stats && {
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

  // 留存率趋势：只画有答题的分档，避免空档把折线拉到 0
  const retentionOption: EChartsOption | null =
    stats && stats.retention.trend.length > 0
      ? {
          ...chartBg,
          grid: { left: 46, right: 16, top: 24, bottom: 28 },
          xAxis: { type: 'category', data: stats.retention.trend.map((p) => p.label.slice(5)), ...AXIS },
          yAxis: { ...AXIS, type: 'value', min: 0, max: 100, axisLabel: { color: dim, formatter: '{value}%' } },
          series: [
            {
              type: 'line',
              name: '留存率',
              smooth: true,
              symbolSize: 4,
              data: stats.retention.trend.map((p) =>
                p.total > 0 ? Math.round((p.correct / p.total) * 1000) / 10 : null
              ),
              itemStyle: { color: okColor },
              lineStyle: { color: okColor },
              // 目标留存率参考线（与实测口径不同，见面板脚注）
              markLine: {
                silent: true,
                symbol: 'none',
                label: {
                  formatter: `目标 ${Math.round(stats.retention.desired * 100)}%`,
                  color: dim,
                  position: 'insideEndTop'
                },
                lineStyle: { color: warnColor, type: 'dashed' },
                data: [{ yAxis: Math.round(stats.retention.desired * 1000) / 10 }]
              }
            }
          ],
          tooltip: {
            trigger: 'axis',
            ...TOOLTIP,
            formatter: (ps: unknown) => {
              const arr = ps as { dataIndex: number; value: number | null }[]
              const i = arr[0]?.dataIndex ?? 0
              const p = stats.retention.trend[i]
              return `${p.label}<br/>答题 ${p.total} 次<br/>非重来 ${p.correct} 次<br/>留存率 ${arr[0]?.value ?? '—'}%`
            }
          }
        }
      : null

  const intervalOption: EChartsOption | null = stats && {
    ...chartBg,
    grid: { left: 40, right: 16, top: 20, bottom: 28 },
    xAxis: { type: 'category', data: stats.intervals.map((i) => i.bucket), ...AXIS },
    yAxis: { type: 'value', ...AXIS },
    series: [
      { type: 'bar', data: stats.intervals.map((i) => i.count), itemStyle: { color: warnColor }, barCategoryGap: '30%' }
    ],
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

      <div className="chart-card">
        <h4>留存率（{range === 'year' ? '按天' : '按月'}）</h4>
        {stats && <RetentionSummary retention={stats.retention} />}
        {retentionOption && <Chart option={retentionOption} />}
        <p className="chart-foot">
          口径：范围内已答题中「评非重来」的比例（撤销已抵消）。它 <b>不等于</b> FSRS 的目标留存率
          {stats ? ` ${Math.round(stats.retention.desired * 100)}%` : ''}
          ——目标值算的是「到期时还记得的概率」，只统计到期的复习卡；本图分母含新卡与学习中卡，
          也与调度参数的预测值不同源，两者只能各自看趋势。
        </p>
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

/** 留存率/耗时摘要行：rate 为 null 时显示「—」而不是 0%，避免误读成全忘了 */
function RetentionSummary({ retention }: { retention: StatsPayload['retention'] }) {
  const pct = retention.rate === null ? '—' : `${(retention.rate * 100).toFixed(1)}%`
  const avg = retention.avgAnswerMs === null ? '—' : `${(retention.avgAnswerMs / 1000).toFixed(1)} 秒`
  return (
    <div className="retention-summary">
      <span>
        <b>{pct}</b> 留存率
      </span>
      <span className="dim">
        （{retention.total} 次答题，{retention.correct} 次非重来）
      </span>
      <span>
        平均 <b>{avg}</b>/卡
      </span>
      <span className="dim">目标 {Math.round(retention.desired * 100)}%</span>
    </div>
  )
}
