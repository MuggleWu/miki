// 工作区文件原语：受管文件路径 + NDJSON 行读。
// 从 WorkspaceService 拆出的纯函数层（不含状态），路径规则集中一处避免散落拼接。
// 卡片行序列化（contentRow/snapshotRow）与加载损坏记账（LoadIssues/noteDamaged）已搬到
// src/shared/workspace-io.ts——移动端子工程（WebView，无 node）要复用同一份序列化实现，
// 两端字节必须一致，不能有第二份。这里按名再导出，既有调用方（workspace.ts）零改动。
import * as fs from 'node:fs'
import * as path from 'node:path'
import { iterateNdjsonText, type LoadIssues } from '../shared/workspace-io'

export {
  contentRow,
  snapshotRow,
  noteDamaged,
  newLoadIssues,
  iterateNdjsonText,
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
 * 从磁盘惰性切出 NDJSON 的非空行（切行语义在 shared，两端共用）。
 * issues 可选：传了就顺带记录「末尾缺换行」（追加写被中断的典型信号，否则只能静默）。
 * 无法解析的行由调用方在 catch 里调 noteDamaged 记账——解析在调用方做。
 */
export function* iterateNdjson(file: string, issues?: LoadIssues): Generator<string> {
  if (!fs.existsSync(file)) return
  yield* iterateNdjsonText(fs.readFileSync(file, 'utf-8'), file, issues)
}

/** 读 NDJSON 非空行（文件缺失返回空数组）。逐行消费请用 iterateNdjson，别先展开成数组 */
export function readNdjson(file: string): string[] {
  return [...iterateNdjson(file)]
}
