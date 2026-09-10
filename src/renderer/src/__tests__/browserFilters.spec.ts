// 卡片库过滤档单测（状态 / 到期窗口）。
// 后端 QueryParams 一直支持 state 与 dueBefore/dueAfter，缺的是渲染层入口；
// 这里钉住档位语义与窗口换算，避免「已逾期」和「今天到期」这类互补档位算错边界。
import { describe, expect, it } from 'vitest'
import { DUE_FILTERS, STATE_FILTERS, dueWindow, normalizeDueFilter, normalizeStateFilter } from '../browser/filters'

/** 本地时间 2026-09-10 14:30（用本地构造，避免测试跑在别的时区就断言失败） */
const NOW = new Date(2026, 8, 10, 14, 30, 0, 0).getTime()
const START_OF_DAY = new Date(2026, 8, 10, 0, 0, 0, 0).getTime()
const END_OF_DAY = new Date(2026, 8, 10, 23, 59, 59, 999).getTime()
const DAY = 86_400_000

describe('过滤档定义', () => {
  it('状态档覆盖全部 + 四种可见状态（含暂停卡池）', () => {
    expect(STATE_FILTERS.map((f) => f.value)).toEqual(['', 'new', 'learning', 'review', 'suspended'])
  })

  it('到期档覆盖不限 + 七个窗口', () => {
    expect(DUE_FILTERS.map((f) => f.value)).toEqual([
      'any',
      'due',
      'today',
      'overdue',
      'days3',
      'days7',
      'days30',
      'scheduled'
    ])
  })
})

describe('dueWindow 窗口换算', () => {
  it('any：两侧都不限制', () => {
    expect(dueWindow('any', NOW)).toEqual({ dueBefore: null, dueAfter: null })
  })

  it('due（已到期）：只限上界为此刻，不限下界（逾期多久都算）', () => {
    expect(dueWindow('due', NOW)).toEqual({ dueBefore: NOW, dueAfter: null })
  })

  it('today（今天到期）：落在本地当日零点至当日末（含今日稍后到点）', () => {
    expect(dueWindow('today', NOW)).toEqual({ dueBefore: END_OF_DAY, dueAfter: START_OF_DAY })
  })

  it('overdue（已逾期）：上界是今天零点，与 today 严格互补不重叠', () => {
    const o = dueWindow('overdue', NOW)
    const t = dueWindow('today', NOW)
    expect(o).toEqual({ dueBefore: START_OF_DAY, dueAfter: null })
    expect(o.dueBefore).toBe(t.dueAfter) // 边界恰好相接，不会同一张卡两档都出现
  })

  it('days3/7/30：从今天零点到今天末 + N 天', () => {
    expect(dueWindow('days3', NOW)).toEqual({ dueBefore: END_OF_DAY + 3 * DAY, dueAfter: START_OF_DAY })
    expect(dueWindow('days7', NOW)).toEqual({ dueBefore: END_OF_DAY + 7 * DAY, dueAfter: START_OF_DAY })
    expect(dueWindow('days30', NOW)).toEqual({ dueBefore: END_OF_DAY + 30 * DAY, dueAfter: START_OF_DAY })
  })

  it('scheduled（已排期）：借 dueAfter=0 排除新卡（新卡无 due）', () => {
    expect(dueWindow('scheduled', NOW)).toEqual({ dueBefore: null, dueAfter: 0 })
  })

  it('除 any 外，至少限制一侧——否则档位形同虚设', () => {
    for (const f of DUE_FILTERS) {
      if (f.value === 'any') continue
      const w = dueWindow(f.value, NOW)
      expect(w.dueBefore !== null || w.dueAfter !== null).toBe(true)
    }
  })

  it('窗口随 now 变化：同一档位跨天得到不同窗口（故不能预先算好存 config）', () => {
    const tomorrow = NOW + DAY
    expect(dueWindow('today', NOW)).not.toEqual(dueWindow('today', tomorrow))
  })
})

describe('非法档位归一', () => {
  it('状态：非法/缺省/非字符串都回落「全部」', () => {
    expect(normalizeStateFilter(undefined)).toBe('')
    expect(normalizeStateFilter(null)).toBe('')
    expect(normalizeStateFilter('')).toBe('')
    expect(normalizeStateFilter('bogus')).toBe('')
    expect(normalizeStateFilter(42)).toBe('')
    expect(normalizeStateFilter('suspended')).toBe('suspended')
  })

  it('到期：非法/缺省回落 any', () => {
    expect(normalizeDueFilter(undefined)).toBe('any')
    expect(normalizeDueFilter(null)).toBe('any')
    expect(normalizeDueFilter('bogus')).toBe('any')
    expect(normalizeDueFilter(0)).toBe('any')
    expect(normalizeDueFilter('days7')).toBe('days7')
  })
})
