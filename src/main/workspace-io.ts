// 工作区文件原语：受管文件路径 + NDJSON 行读 + 卡片行序列化。
// 从 WorkspaceService 拆出的纯函数层（不含状态），路径规则集中一处避免散落拼接。
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Card, CardContent, CardSnapshot } from '../shared/types'

/** 压实后的卡片行 = 内容 + 调度检查点快照；旧格式行无 fsrs/reps/lapses 字段（视为零值 + 全量重放）。
 * __mikiSeq：该行调度快照已反映到的事件水位；缺省时回落到基文件 meta 的 __mikiCheckpoint */
export interface CardCheckpointRow extends CardContent {
  fsrs?: CardSnapshot | null
  reps?: number
  lapses?: number
  __mikiSeq?: number
}

/** 工作区受管文件的路径规则（decks/config/stats + cards/review-log 下各文件） */
export class WorkspacePaths {
  constructor(readonly root: string) {}

  decksFile(): string {
    return path.join(this.root, 'decks.json')
  }

  deckCardsFile(deckId: string): string {
    return path.join(this.root, 'cards', `${deckId}.ndjson`)
  }

  deckDeltaFile(deckId: string): string {
    return path.join(this.root, 'cards', `${deckId}.delta.ndjson`)
  }

  statsFile(): string {
    return path.join(this.root, 'stats.json')
  }

  /** review-log 按月分文件 */
  logFile(t: number): string {
    const d = new Date(t)
    const p = (n: number) => String(n).padStart(2, '0')
    return path.join(this.root, 'review-log', `${d.getFullYear()}-${p(d.getMonth() + 1)}.ndjson`)
  }

  configJson(): string {
    return path.join(this.root, 'config.json')
  }
}

/** 读 NDJSON 非空行（文件缺失返回空数组） */
export function readNdjson(file: string): string[] {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
}

/** 卡片内容行：只序列化内容字段（调度快照走 snapshotRow） */
export function contentRow(c: Card): string {
  const { deckId: _d, fsrs: _f, reps: _r, lapses: _l, tie: _t, seqApplied: _s, ...content } = c
  return JSON.stringify(content)
}

/** 压实快照行：内容 + 调度状态（不含 deckId/tie/水位） */
export function snapshotRow(c: Card): string {
  const { deckId: _d, tie: _t, seqApplied: _s, ...row } = c
  return JSON.stringify(row)
}
