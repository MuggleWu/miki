// 工作区 NDJSON 行序列化 + 加载损坏记账：纯函数 / 纯类型，零 node 依赖。
// 桌面端（main）与移动端（Capacitor/WebView，拿不到 node:fs）共用同一份实现——
// 两端写出的 NDJSON 行必须逐字节一致，所以这里只允许有一份代码：
// 改动任何字段顺序、解构顺序或 JSON.stringify 行为前，先确认两端兼容性。
import type { Card, CardContent, CardSnapshot } from './types'

/** 压实后的卡片行 = 内容 + 调度检查点快照；旧格式行无 fsrs/reps/lapses 字段（视为零值 + 全量重放）。
 * __mikiSeq：该行调度快照已反映到的事件水位；缺省时回落到基文件 meta 的 __mikiCheckpoint */
export interface CardCheckpointRow extends CardContent {
  fsrs?: CardSnapshot | null
  reps?: number
  lapses?: number
  __mikiSeq?: number
}

/** 一次加载里发现的文件级问题（损坏检测用）：非空行无法 JSON.parse / 文件末尾没有换行 */
export interface LoadIssues {
  /** file → 无法解析的非空行数 */
  damaged: Map<string, number>
  /** file → 末尾缺换行（很可能是追加写被中断，那一行可能已被丢掉） */
  truncated: Set<string>
}

/** 空账簿：一次加载的损坏记账从这里起步 */
export function newLoadIssues(): LoadIssues {
  return { damaged: new Map(), truncated: new Set() }
}

/** 记一条无法解析的非空行 */
export function noteDamaged(issues: LoadIssues | undefined, file: string): void {
  if (!issues) return
  issues.damaged.set(file, (issues.damaged.get(file) ?? 0) + 1)
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
