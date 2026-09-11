// 工作区文件原语：受管文件路径 + NDJSON 行读。
// 从 WorkspaceService 拆出的纯函数层（不含状态），路径规则集中一处避免散落拼接。
// 卡片行序列化（contentRow/snapshotRow）与加载损坏记账（LoadIssues/noteDamaged）已搬到
// src/shared/workspace-io.ts——移动端子工程（WebView，无 node）要复用同一份序列化实现，
// 两端字节必须一致，不能有第二份。这里按名再导出，既有调用方（workspace.ts）零改动。
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { LoadIssues } from '../shared/workspace-io'

export {
  contentRow,
  snapshotRow,
  noteDamaged,
  newLoadIssues,
  type CardCheckpointRow,
  type LoadIssues
} from '../shared/workspace-io'

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
 *
 * issues 可选：传了就顺带记录「末尾缺换行」（追加写被中断的典型信号，否则只能静默）。
 * 无法解析的行由调用方在 catch 里调 noteDamaged 记账——解析在调用方做。
 */
export function* iterateNdjson(file: string, issues?: LoadIssues): Generator<string> {
  if (!fs.existsSync(file)) return
  const text = fs.readFileSync(file, 'utf-8')
  // 末尾没有换行 = 最后一条记录可能只写了一半（appendFileSync 不是原子写）
  if (issues && text.length > 0 && !text.endsWith('\n')) issues.truncated.add(file)
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
