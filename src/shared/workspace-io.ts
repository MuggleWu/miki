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

/**
 * NDJSON 文本 → 非空行（纯函数，不碰文件系统）。
 *
 * 桌面端从磁盘读、移动端从 Capacitor 插件读，两边的**解析语义必须完全一致**：
 * 跳过只有空白的行、末尾缺换行要记进 issues.truncated（追加写被中断的信号），
 * 所以切行逻辑只能有一份，放在这里。
 *
 * 为什么不用 `text.split('\n').filter(...)`：那条链路会同时持有整个文件字符串 +
 * 每行的字符串数组（split 出来的子串在 V8 里对大文件是拷贝，不是切片），峰值内存约等于
 * 文件的 2 倍再加上数组本身。卡片基文件与 review-log 都会随使用无限增长，这里改成按需切：
 * 峰值 = 文件本身 + 一个行子串，且调用方是「解析一行、丢掉一行」的流式消费。
 *
 * 语义（与旧实现一致）：跳过只含空白的行；顺带 trim 两端空白——全部调用方都是 JSON.parse，
 * 尾随空白本来就被忽略（顺带把 CRLF 的 \r 也挡在外面）。
 */
export function* iterateNdjsonText(text: string, file: string, issues?: LoadIssues): Generator<string> {
  // 末尾没有换行 = 最后一条记录可能只写了一半（追加写不是原子写）
  if (issues && text.length > 0 && !text.endsWith('\n')) issues.truncated.add(file)
  // 单趟正则找出「至少含一个非空白字符」的最长片段，避免逐行 subarray + trim 的中间对象
  const LINE = /[^\s](?:[^\n]*[^\s])?/g
  let m: RegExpExecArray | null
  while ((m = LINE.exec(text)) !== null) {
    yield m[0]
  }
}
