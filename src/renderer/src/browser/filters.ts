// 卡片库过滤档（状态 / 到期窗口）：从 Browser.tsx 收敛出的纯逻辑，便于直测。
//
// 后端 QueryParams 一直支持 state 与 dueBefore/dueAfter（core/query.ts 的单趟过滤 +
// api-server 的解析都就绪），缺的只是渲染层入口——原先只能靠搜索词拼凑。
//
// 「到期」档的窗口随当前时刻变化（今天到期 / N 天内 / 已逾期都会跨天），所以窗口
// 不带进 state，而是每次取数时按 now 现算；档位本身两机提交差异会污染 git，也存 config。
import type { DueFilter, QueryState } from '../../../shared/types'

export const STATE_FILTERS: { value: QueryState | ''; label: string }[] = [
  { value: '', label: '全部状态' },
  { value: 'new', label: '未学习' },
  { value: 'learning', label: '学习中' },
  { value: 'review', label: '待复习' },
  // 暂停卡池：leech 难卡集中在这里，原先只能一张张翻
  { value: 'suspended', label: '已暂停' }
]

/** 除 any 外都只看已排期卡：新卡没有 due，不该出现在「已到期」里 */
export const DUE_FILTERS: { value: DueFilter; label: string }[] = [
  { value: 'any', label: '全部到期' },
  { value: 'due', label: '已到期' },
  { value: 'today', label: '今天到期' },
  { value: 'overdue', label: '已逾期' },
  { value: 'days3', label: '3 天内' },
  { value: 'days7', label: '7 天内' },
  { value: 'days30', label: '30 天内' },
  { value: 'scheduled', label: '已排期' }
]

export const STATE_FILTER_VALUES = new Set<string>(STATE_FILTERS.map((f) => f.value))
export const DUE_FILTER_VALUES = new Set<string>(DUE_FILTERS.map((f) => f.value))

/** 外部输入（config.json 手改 / 旧版本残留）→ 合法档位，非法回落默认 */
export function normalizeStateFilter(raw: unknown): QueryState | '' {
  return typeof raw === 'string' && STATE_FILTER_VALUES.has(raw) ? (raw as QueryState | '') : ''
}

export function normalizeDueFilter(raw: unknown): DueFilter {
  return typeof raw === 'string' && DUE_FILTER_VALUES.has(raw) ? (raw as DueFilter) : 'any'
}

const DAY_MS = 86_400_000

/** 过滤档 + 当前时刻 → 查询到期窗口（null = 不限制该侧） */
export function dueWindow(filter: DueFilter, now: number): { dueBefore: number | null; dueAfter: number | null } {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0)
  const endOfToday = new Date(now).setHours(23, 59, 59, 999)
  switch (filter) {
    case 'due':
      // 已到期 = 此刻之前（含今日稍后到点的学习卡？不含：那是「今天到期」的语义）
      return { dueBefore: now, dueAfter: null }
    case 'today':
      return { dueBefore: endOfToday, dueAfter: startOfToday }
    case 'overdue':
      // 已逾期 = 今天零点之前，与「今天到期」互补
      return { dueBefore: startOfToday, dueAfter: null }
    case 'days3':
      return { dueBefore: endOfToday + 3 * DAY_MS, dueAfter: startOfToday }
    case 'days7':
      return { dueBefore: endOfToday + 7 * DAY_MS, dueAfter: startOfToday }
    case 'days30':
      return { dueBefore: endOfToday + 30 * DAY_MS, dueAfter: startOfToday }
    case 'scheduled':
      // 有调度进度即可（dueAfter=0 借「新卡被排除」的后端语义）
      return { dueBefore: null, dueAfter: 0 }
    default:
      return { dueBefore: null, dueAfter: null }
  }
}
