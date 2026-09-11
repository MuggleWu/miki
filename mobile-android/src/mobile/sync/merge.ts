// 同步的合并判定：纯函数，不碰网络与文件系统（同步里最危险的一段，必须能单测）。
//
// 依据（设计文档「跨端同步契约」）：miki 的数据是 append-only 文本事件流，
// "两台设备各自追加"的语义并集就是行拼接。这条成立有两个前提，代码里都做了检查：
//   ① 同一行必须字节一致 —— 两端共用 contentRow()/序列化函数，所以能按行比较；
//   ② 两侧都只能是"在原文件末尾追加"，不能有重写 —— 桌面端压实会重写基文件，
//      那种情况下行拼接没有意义，必须拦下来而不是猜。
import { iterateNdjsonText } from '@shared/workspace-io'

/** 一次比对里一个文件的三方状态。base 是"上次同步后记录的内容"（首次同步为 null） */
export interface FileCompare {
  path: string
  /** 本地当前内容；文件不存在为 null */
  local: string | null
  /** 远端当前内容；远端没有这个文件为 null */
  remote: string | null
  /** 上次同步时代的内容；没有记录为 null（→ 退化成前缀判定） */
  base?: string | null
}

export type MergeAction =
  /** 两侧一致或都无需改动 */
  | 'skip'
  /** 只有本地变了：把本地内容推上去 */
  | 'keep-local'
  /** 只有远端变了：把远端内容落到本地 */
  | 'take-remote'
  /** 两侧各自追加：按行并集合并，写回两侧 */
  | 'union'
  /** 不能自动决定：停止同步并提示，绝不猜测 */
  | 'blocked'

export interface MergeResult {
  path: string
  action: MergeAction
  /** 合并后的内容；skip/keep-local/take-remote 为 null（不需要写回） */
  content: string | null
  /** 给人看的原因（同步结果页与日志都要能讲清"为什么这么做"） */
  reason: string
  /** union 时的行数明细，用于同步摘要与事后审计 */
  detail?: { remote: number; local: number; merged: number; appended: number }
}

/** NDJSON 取行：复用 shared 的切行语义（跳过空行、trim 两端空白），两端必须一致 */
export function linesOf(text: string, path: string): string[] {
  return [...iterateNdjsonText(text, path)]
}

/**
 * 是否存在"压实痕迹"：基文件被重写过（行里带调度检查点 __mikiSeq / meta 行 __mikiCheckpoint）。
 * 有痕迹时行拼接不成立——被压实的那些行在另一侧可能以完全不同的行存在。
 */
function looksCompacted(lines: string[], path: string): boolean {
  if (!path.endsWith('.ndjson')) return false
  return lines.some((l) => l.includes('__mikiSeq') || l.includes('__mikiCheckpoint'))
}

function isPrefix(short: string[], long: string[]): boolean {
  if (short.length > long.length) return false
  for (let i = 0; i < short.length; i++) if (short[i] !== long[i]) return false
  return true
}

/** 多重集视角的行数：同一行出现多次要按次数算（两次相同答题事件是合法的） */
function countLines(lines: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1)
  return m
}

/**
 * 行并集：以远端为骨架，把"远端没有的本地行"按本地原顺序接在末尾。
 * 多重集语义：两侧都出现的同一行只保留一份（按次数相抵）。
 */
export function unionLines(remoteLines: string[], localLines: string[]): { merged: string[]; appended: number } {
  const remaining = countLines(remoteLines)
  const merged = [...remoteLines]
  let appended = 0
  for (const line of localLines) {
    const n = remaining.get(line) ?? 0
    if (n > 0) {
      remaining.set(line, n - 1)
      continue
    }
    merged.push(line)
    appended++
  }
  return { merged, appended }
}

/**
 * 校验候选合并结果：这是"合并后重放校验"里能纯函数做的那一半。
 *
 * 能在这里查的：行是否可解析、两侧的行有没有丢或重复。
 * 查不到的（属于编排层，用真工作区重放）：调度状态是否等于两侧事件的并集。
 * 两者都要有——只查前者会漏掉"行都在但顺序错"，只查后者会在坏行上白跑一遍重放。
 */
export function validateUnion(
  remoteLines: string[],
  localLines: string[],
  merged: string[]
): { ok: boolean; why: string } {
  const r = countLines(remoteLines)
  const l = countLines(localLines)
  const m = countLines(merged)

  for (const [line, n] of r) {
    const got = m.get(line) ?? 0
    if (got < n) return { ok: false, why: `远端有 ${n} 次的行在合并结果里只剩 ${got} 次` }
  }
  for (const [line, n] of l) {
    const got = m.get(line) ?? 0
    if (got < n) return { ok: false, why: `本地有 ${n} 次的行在合并结果里只剩 ${got} 次` }
  }
  const expected = remoteLines.length + localLines.length - (r.size + l.size - m.size)
  if (merged.length !== expected) {
    return { ok: false, why: `合并行数 ${merged.length} 与预期 ${expected} 不一致` }
  }
  for (const line of merged) {
    try {
      JSON.parse(line)
    } catch {
      return { ok: false, why: `合并结果里出现了无法解析的行（前 60 字符：${line.slice(0, 60)}）` }
    }
  }
  return { ok: true, why: '' }
}

/** 单个文件的合并判定 */
export function mergeFile(c: FileCompare): MergeResult {
  const { path, local, remote, base = null } = c

  if (local === null && remote === null) return { path, action: 'skip', content: null, reason: '两侧都没有这个文件' }
  if (remote === null) {
    // 全新文件：整份都是新增
    const n = linesOf(local ?? '', path).length
    return {
      path,
      action: 'keep-local',
      content: null,
      reason: '远端没有这个文件，本地新建的',
      detail: { remote: 0, local: n, merged: n, appended: n }
    }
  }
  if (local === null) return { path, action: 'take-remote', content: remote, reason: '本地没有这个文件，直接落地' }
  if (local === remote) return { path, action: 'skip', content: null, reason: '内容一致' }

  const localLines = linesOf(local, path)
  const remoteLines = linesOf(remote, path)

  /**
   * 「推本地」统一在这里构造，并且一律带上本次**新增**的行数。
   * commit message 与同步明细靠它说话——写整份行数会让人以为每次都在重推全量
   * （第一版就是这么错的，集成测试抓到：只多做了一题，提交信息却写 2 reviews）。
   */
  const keepLocal = (reason: string): MergeResult => ({
    path,
    action: 'keep-local',
    content: null,
    reason,
    detail: {
      remote: remoteLines.length,
      local: localLines.length,
      merged: localLines.length,
      appended: unionLines(remoteLines, localLines).appended
    }
  })

  // 三方判定优先：有 base 时，"哪一侧变了"是确定的，不需要靠前缀猜
  if (base !== null) {
    if (base === local)
      return { path, action: 'take-remote', content: remote, reason: '本地自上次同步后未改动，取远端' }
    if (base === remote) return keepLocal('远端自上次同步后未改动，推本地')
  }

  // 非 NDJSON（decks.json / config.json）：两侧都改过时不能按行拼——
  // JSON 是整体文档，"行并集"会拼出一个谁也解析不了的怪东西。停。
  if (!path.endsWith('.ndjson')) {
    return {
      path,
      action: 'blocked',
      content: null,
      reason: '两侧都改了这份 JSON，无法按行合并。请在桌面端决定用哪一份（通常是它更新的那份），再回到手机同步。'
    }
  }

  // 前缀关系：一侧是另一侧的严格延伸 → 就是"单纯追加"，不需要合并
  if (isPrefix(remoteLines, localLines)) {
    return keepLocal(`本地多 ${localLines.length - remoteLines.length} 行（纯追加）`)
  }
  if (isPrefix(localLines, remoteLines)) {
    return {
      path,
      action: 'take-remote',
      content: remote,
      reason: `远端多 ${remoteLines.length - localLines.length} 行（纯追加）`
    }
  }

  // 两侧各自追加：行并集
  const merged = unionLines(remoteLines, localLines)

  // 有压实痕迹就停：被重写过的行在另一侧不一定以同样的行存在，
  // 行拼接会得到"看着没问题、语义已经错了"的结果——这是最坏的一类 bug。
  const compactedRemote = looksCompacted(remoteLines, path)
  const compactedLocal = looksCompacted(localLines, path)
  if (compactedRemote || compactedLocal) {
    return {
      path,
      action: 'blocked',
      content: null,
      reason:
        `${compactedRemote ? '远端' : ''}${compactedRemote && compactedLocal ? '与' : ''}${compactedLocal ? '本地' : ''}` +
        '这份文件里有压实（重写）痕迹，且两侧都改过。行拼接对"被重写过的文件"不成立，' +
        '请在桌面端先把它同步一致，再回到手机上同步。'
    }
  }

  const v = validateUnion(remoteLines, localLines, merged.merged)
  if (!v.ok) return { path, action: 'blocked', content: null, reason: `合并校验未通过：${v.why}` }

  return {
    path,
    action: 'union',
    content: merged.merged.join('\n') + '\n',
    reason: `两侧各自追加，按行合并（远端 ${remoteLines.length} + 本地新增 ${merged.appended} = ${merged.merged.length} 行）`,
    detail: {
      remote: remoteLines.length,
      local: localLines.length,
      merged: merged.merged.length,
      appended: merged.appended
    }
  }
}

/** 一批文件的合并结果 → 摘要（推什么、拉什么、有没有被拦住） */
export function summarize(results: MergeResult[]): {
  push: MergeResult[]
  pull: MergeResult[]
  blocked: MergeResult[]
  unchanged: MergeResult[]
} {
  return {
    push: results.filter((r) => r.action === 'keep-local' || r.action === 'union'),
    pull: results.filter((r) => r.action === 'take-remote' || r.action === 'union'),
    blocked: results.filter((r) => r.action === 'blocked'),
    unchanged: results.filter((r) => r.action === 'skip')
  }
}
