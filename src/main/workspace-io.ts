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

/**
 * 惰性切出 NDJSON 的非空行：每次只产出一个行的子串，不构造「全部行」数组。
 *
 * 为什么不用 readFileSync().split('\n').filter(...)：那条链路会同时持有
 * 整个文件字符串 + 每行的字符串数组（split 出来的子串在 V8 里对大文件是拷贝，
 * 不是切片），峰值内存约等于文件的 2 倍再加上数组本身。卡片基文件与 review-log
 * 都会随使用无限增长（单牌组 4000 卡已是兆级），这里改成按需切：
 * 峰值 = 文件本身 + 一个行子串，且调用方是「解析一行、丢掉一行」的流式消费。
 *
 * 语义与旧实现一致（都跳过只有空白的行），差别仅在于顺带 trim 了两端空白：
 * 全部调用方都是 JSON.parse，尾随空白本来就被忽略（顺带把 CRLF 的 \r 也挡在外面）。
 */
export function* iterateNdjson(file: string): Generator<string> {
  if (!fs.existsSync(file)) return
  const text = fs.readFileSync(file, 'utf-8')
  // 单趟正则找出「至少含一个非空白字符」的最长片段，避免逐行 subarray + trim 的中间对象
  const LINE = /[^\s](?:[^\n]*[^\s])?/g
  let m: RegExpExecArray | null
  while ((m = LINE.exec(text)) !== null) {
    yield m[0]
  }
}

/** 读 NDJSON 非空行（文件缺失返回空数组）。逐行消费请用 iterateNdjson，别先展开成数组 */
export function readNdjson(file: string): string[] {
  return [...iterateNdjson(file)]
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
