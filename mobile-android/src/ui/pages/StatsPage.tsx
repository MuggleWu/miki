// 统计：与桌面端同样的六板块（热力图 / 预测 / 复习 / 留存 / 卡片数量 / 复习间隔），窄屏纵向堆叠。
//
// 数据仍旧读 core/stats 的聚合结果（getStats 从 review-log 现算），
// 不读 stats.json——那是派生缓存，且桌面端自己也在 .gitignore 里排除它。
// 图表用 ECharts（动态 import，只在打开本页时加载，主包不受影响），口径与桌面端逐项对齐。
import { useState } from 'react'
import { useApp } from '../store'
import { useWorkspace } from '../use-workspace'
import { Chart, useChartPalette, type ChartPalette } from '../components/Chart'
import type { StatsPayload } from '@shared/types'
import type { EChartsOption } from 'echarts'

type Range = 'year' | 'all'

export function StatsPage(): JSX.Element {
  const ws = useWorkspace()
  const back = useApp((s) => s.back)
  const palette = useChartPalette()
  const [deckId, setDeckId] = useState<string | null>(null)
  const [range, setRange] = useState<Range>('year')

  const decks = ws.deckInfos()
  // 直接算不套 memo：useWorkspace() 订阅写操作计数，答题后回到本页会得到新结果。
  // getStats 内部按 (参数, 事件序号) 做了缓存，重复打开同一组合不会重算。
  const stats: StatsPayload = ws.getStats({ deckId, range })

  // 数字用等宽字形，避免占比在切换牌组时左右跳动
  return (
    <>
      <div className="page-head">
        <button className="icon-btn" onClick={back} aria-label="返回">
          ‹
        </button>
        <h1>统计</h1>
      </div>

      <div className="filter-bar">
        <select value={deckId ?? ''} onChange={(e) => setDeckId(e.target.value || null)}>
          <option value="">全部牌组</option>
          {decks.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <select value={range} onChange={(e) => setRange(e.target.value as Range)}>
          <option value="year">近一年</option>
          <option value="all">全部</option>
        </select>
      </div>

      <div className="page-body">
        {range === 'year' ? (
          <Section title="热力图">
            {stats.heatmap.length > 0 ? (
              <Chart option={heatmapOption(stats, palette)} height={160} />
            ) : (
              <p className="muted">近一年还没有学习记录。</p>
            )}
          </Section>
        ) : null}

        <Section title="预测（未来到期）">
          <Chart option={forecastOption(stats, palette)} height={170} />
        </Section>

        <Section title={`复习（${range === 'year' ? '按天' : '按月'}）`}>
          <Chart option={reviewsOption(stats, palette)} height={170} />
        </Section>

        <Section title={`留存率（${range === 'year' ? '按天' : '按月'}）`}>
          <RetentionHead stats={stats} />
          <Chart option={retentionOption(stats, palette)} height={160} />
          <p className="chart-foot muted">
            口径：范围内已答题中「评非重来」的比例（撤销已抵消）。它<b>不等于</b> FSRS 的目标留存率{' '}
            {Math.round(stats.retention.desired * 100)}%——目标值算的是「到期时还记得的概率」，只统计
            到期的复习卡；本图分母含新卡与学习中卡，两者只能各自看趋势。
          </p>
        </Section>

        <Section title="卡片数量">
          <Chart option={stateOption(stats, palette)} height={170} />
        </Section>

        <Section title="复习间隔">
          <Chart option={intervalOption(stats, palette)} height={170} />
        </Section>
      </div>
    </>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="card chart-card">
      <h2>{title}</h2>
      {children}
    </section>
  )
}

function RetentionHead({ stats }: { stats: StatsPayload }): JSX.Element {
  const r = stats.retention
  return (
    <ul className="kv">
      <li>
        <span>留存率</span>
        <b>{r.rate === null ? '—' : `${Math.round(r.rate * 100)}%`}</b>
      </li>
      <li>
        <span>已答题 / 评非重来</span>
        <b>
          {r.total} / {r.correct}
        </b>
      </li>
      <li>
        <span>平均单卡耗时</span>
        <b>{r.avgAnswerMs === null ? '—' : `${(r.avgAnswerMs / 1000).toFixed(1)} 秒`}</b>
      </li>
      <li>
        <span>目标留存率</span>
        <b>{Math.round(r.desired * 100)}%</b>
      </li>
    </ul>
  )
}

// ---------- 图表配置（与桌面端 Stats.tsx 逐项对齐，只是尺寸更窄） ----------

interface Axis {
  axisLabel: { color: string; fontSize: number }
  splitLine: { lineStyle: { color: string } }
}

function axis(p: ChartPalette): Axis {
  // 手机上刻度字要小一号，否则 38 根柱子的标签会糊在一起
  return { axisLabel: { color: p.dim, fontSize: 10 }, splitLine: { lineStyle: { color: p.split } } }
}

function base(p: ChartPalette): EChartsOption {
  return { backgroundColor: 'transparent', textStyle: { color: p.fg } }
}

function tooltip(p: ChartPalette): EChartsOption['tooltip'] {
  return {
    backgroundColor: p.fg === '#1c1c1e' ? '#ffffff' : '#1b1d21',
    borderColor: p.split,
    textStyle: { color: p.fg, fontSize: 12 }
  }
}

function forecastOption(stats: StatsPayload, p: ChartPalette): EChartsOption {
  return {
    ...base(p),
    grid: { left: 34, right: 10, top: 12, bottom: 26 },
    xAxis: { type: 'category', data: stats.forecast.map((f) => f.label), ...axis(p) },
    yAxis: { type: 'value', ...axis(p) },
    series: [{ type: 'bar', data: stats.forecast.map((f) => f.count), itemStyle: { color: p.accent } }],
    tooltip: {
      trigger: 'axis',
      ...tooltip(p),
      formatter: (ps: unknown) => {
        const i = (ps as { dataIndex: number }[])[0].dataIndex
        const f = stats.forecast[i]
        return `${f.range}<br/>${f.count} 张`
      }
    }
  }
}

function heatmapOption(stats: StatsPayload, p: ChartPalette): EChartsOption {
  const dark = document.documentElement.dataset.theme === 'dark'
  return {
    ...base(p),
    visualMap: {
      min: 0,
      max: 60,
      show: false,
      inRange: {
        color: dark ? ['#333333', '#28497c', '#3f74c4', '#589df6'] : ['#e9ebf0', '#a8b8f0', '#6f8cff', '#3f55c0']
      }
    },
    calendar: {
      range: [stats.heatmap[0]?.date, stats.heatmap[stats.heatmap.length - 1]?.date],
      cellSize: ['auto', 12],
      itemStyle: {
        color: dark ? '#333333' : '#e9ebf0',
        borderColor: dark ? '#2b2b2b' : '#f5f6f8',
        borderWidth: 2,
        borderRadius: 2
      },
      splitLine: { show: false },
      yearLabel: { show: false },
      monthLabel: { color: p.dim, fontSize: 10 },
      dayLabel: { color: p.dim, nameMap: 'ZH', fontSize: 9 },
      top: 20,
      left: 30,
      right: 6
    },
    series: [{ type: 'heatmap', coordinateSystem: 'calendar', data: stats.heatmap.map((h) => [h.date, h.count]) }],
    tooltip: {
      ...tooltip(p),
      formatter: (v: unknown) => `${(v as { value: [string, number] }).value.join('：')} 张`
    }
  }
}

function reviewsOption(stats: StatsPayload, p: ChartPalette): EChartsOption {
  return {
    ...base(p),
    grid: { left: 34, right: 10, top: 24, bottom: 26 },
    legend: { textStyle: { color: p.dim, fontSize: 11 }, top: 0, right: 0, itemWidth: 12, itemHeight: 8 },
    xAxis: { type: 'category', data: stats.reviews.map((r) => r.label.slice(5)), ...axis(p) },
    yAxis: { type: 'value', ...axis(p) },
    series: [
      {
        name: '总答题',
        type: 'bar',
        stack: 'r',
        data: stats.reviews.map((r) => r.total),
        itemStyle: { color: p.accent }
      },
      {
        name: '评重来',
        type: 'bar',
        stack: 'r',
        data: stats.reviews.map((r) => r.again),
        itemStyle: { color: p.danger }
      }
    ],
    tooltip: { trigger: 'axis', ...tooltip(p) }
  }
}

function retentionOption(stats: StatsPayload, p: ChartPalette): EChartsOption {
  return {
    ...base(p),
    grid: { left: 34, right: 10, top: 12, bottom: 26 },
    xAxis: { type: 'category', data: stats.retention.trend.map((t) => t.label.slice(5)), ...axis(p) },
    yAxis: {
      type: 'value',
      min: 0,
      max: 100,
      axisLabel: { color: p.dim, fontSize: 10, formatter: '{value}%' },
      splitLine: { lineStyle: { color: p.split } }
    },
    series: [
      {
        type: 'line',
        data: stats.retention.trend.map((t) => (t.total === 0 ? null : Math.round((t.correct / t.total) * 100))),
        itemStyle: { color: p.ok },
        lineStyle: { color: p.ok },
        symbolSize: 5,
        connectNulls: false
      },
      {
        // 目标线：虚线，与实测线区分开（两者不同源，只看趋势）
        type: 'line',
        data: [],
        markLine: {
          silent: true,
          symbol: 'none',
          data: [{ yAxis: Math.round(stats.retention.desired * 100) }],
          lineStyle: { color: p.warn, type: 'dashed' },
          label: { color: p.warn, fontSize: 10, formatter: '目标' }
        }
      }
    ],
    tooltip: { trigger: 'axis', ...tooltip(p) }
  }
}

function stateOption(stats: StatsPayload, p: ChartPalette): EChartsOption {
  const c = stats.stateCounts
  return {
    ...base(p),
    tooltip: { ...tooltip(p), trigger: 'item' },
    series: [
      {
        type: 'pie',
        radius: ['42%', '68%'],
        center: ['50%', '52%'],
        label: { color: p.dim, fontSize: 10, formatter: '{b}\n{@c}' },
        // 三档与桌面端一致（DeckCounts 就是这三项；暂停卡不在其中）
        data: [
          { name: '未学习', value: c.new, itemStyle: { color: p.accent } },
          { name: '学习中', value: c.learning, itemStyle: { color: p.warn } },
          { name: '待复习', value: c.review, itemStyle: { color: p.ok } }
        ].filter((d) => d.value > 0)
      }
    ]
  }
}

function intervalOption(stats: StatsPayload, p: ChartPalette): EChartsOption {
  return {
    ...base(p),
    grid: { left: 34, right: 10, top: 12, bottom: 26 },
    xAxis: { type: 'category', data: stats.intervals.map((i) => i.bucket), ...axis(p) },
    yAxis: { type: 'value', ...axis(p) },
    series: [{ type: 'bar', data: stats.intervals.map((i) => i.count), itemStyle: { color: p.warn } }],
    tooltip: { trigger: 'axis', ...tooltip(p) }
  }
}
