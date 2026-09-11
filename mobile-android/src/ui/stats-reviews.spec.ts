// 统计页「复习」图：总答题与评重来必须是并列双柱，不能堆叠。
//
// 为什么值得单独钉住：`again` 是 `total` 的子集（core/stats 分别累加），两条系列一旦 stack 到同一组，
// ECharts 把柱高画成两者之和——不是难看一点，而是读出来的数就是错的：重来越多柱子越虚高。
// 桌面端同图（src/renderer/src/stats/Stats.tsx）是并列、没有 stack，本页文件头写着「口径与桌面端逐项对齐」。
//
// 为什么断言 series 组装结果而不是源码文本：node 环境没有 DOM，挂载不了图表；而源码级正则挡不住
// 「通过变量/展开把 stack 塞回来」这种写法，直接检查返回对象的键则一律看得见。
// 覆盖的退化：重新加回 stack、把 total/again 接反或合并、少画一条系列。
import { describe, expect, it } from 'vitest'
import type { StatsPayload } from '@shared/types'
import type { ChartPalette } from './components/Chart'
import { reviewsSeries } from './pages/StatsPage'

const PALETTE: ChartPalette = {
  fg: '#1c1c1e',
  dim: '#8a8a8e',
  split: '#e5e5ea',
  accent: '#3f55c0',
  ok: '#2f9e44',
  danger: '#e03131',
  warn: '#e8930c'
}

/** 只关心 reviews 的用例：其余板块对本函数无影响，用断言顶掉字段完整性检查 */
function statsWith(reviews: { label: string; total: number; again: number }[]): StatsPayload {
  return { reviews } as StatsPayload
}

describe('统计页复习图：并列双柱而不是堆叠', () => {
  const stats = statsWith([
    { label: '2026-09-01', total: 12, again: 4 },
    { label: '2026-09-02', total: 5, again: 0 },
    { label: '2026-09-03', total: 0, again: 0 }
  ])

  it('两条系列各自绑定 total / again，顺序与图例一致', () => {
    const series = reviewsSeries(stats, PALETTE)
    expect(series.map((s) => s.name)).toEqual(['总答题', '评重来'])
    // 接反或相加都会在这里露出来：总答题必须是 total，评重来必须是 again
    expect(series.map((s) => s.data)).toEqual([
      [12, 5, 0],
      [4, 0, 0]
    ])
  })

  it('两条系列都没有 stack（有 stack 且同组 = 柱高变成两者之和）', () => {
    const series = reviewsSeries(stats, PALETTE)
    const stacks = series.map((s) => (s as { stack?: string }).stack)
    expect(stacks).toEqual([undefined, undefined])
  })
})
