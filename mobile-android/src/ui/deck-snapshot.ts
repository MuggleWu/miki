// 首屏快照：把上次退出时首页那一屏的数字存在本机偏好里，供下一次启动先画出来。
//
// 为什么需要：启动要 1.1–1.4s（读卡片文件 + 重放 review-log），这段时间首页只有一句
// "正在打开工作区…"，看着像空白。把上次的数字先画出来，打开就能看到自己的牌组，真数据到了
// 再无缝替换——用户感知的等待从"1 秒多"变成"一帧"。
//
// 边界：这是**纯展示快照**，不进工作区、不同步、不参与任何调度或统计口径；读坏了就当没有，
// 绝不能让一段坏 JSON 拖累启动（这也是下面所有失败都返回 null 的原因）。
import { PREF_KEYS, prefGet, prefSet } from '@mobile/prefs'
import type { DeckInfo } from '@shared/types'

export interface DeckSnapshotRow {
  id: string
  name: string
  total: number
  new: number
  due: number
}

export interface DeckSnapshot {
  /** 快照时间（ms）：只用于排查，界面不显示 */
  at: number
  /** 上次退出时的「今日已学」次数 */
  today: number
  decks: DeckSnapshotRow[]
}

/** 从实时工作区取一份快照（口径与首页一致：总数/未学习/到期逐项照抄） */
export function snapshotFrom(decks: DeckInfo[], today: number): DeckSnapshot {
  return {
    at: Date.now(),
    today,
    decks: decks.map((d) => ({
      id: d.id,
      name: d.name,
      total: d.counts.total,
      new: d.counts.new,
      due: d.counts.due
    }))
  }
}

function isRow(v: unknown): v is DeckSnapshotRow {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return (
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    typeof r.total === 'number' &&
    typeof r.new === 'number' &&
    typeof r.due === 'number'
  )
}

/** 解析偏好里的快照文本；任何不合规都返回 null（没有快照就退回原来的等待界面） */
export function parseDeckSnapshot(raw: string | null): DeckSnapshot | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<DeckSnapshot>
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.decks)) return null
    const decks = parsed.decks.filter(isRow)
    if (decks.length === 0) return null
    return {
      at: typeof parsed.at === 'number' ? parsed.at : 0,
      today: typeof parsed.today === 'number' ? parsed.today : 0,
      decks
    }
  } catch {
    return null
  }
}

export async function readDeckSnapshot(): Promise<DeckSnapshot | null> {
  return parseDeckSnapshot(await prefGet(PREF_KEYS.deckSnapshot))
}

export async function saveDeckSnapshot(snap: DeckSnapshot): Promise<void> {
  await prefSet(PREF_KEYS.deckSnapshot, JSON.stringify(snap))
}
