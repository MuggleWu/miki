// 同步相关的类型与常量（客户端与编排层共用，避免循环引用）
import type { GithubClient } from './github'

export interface SyncCreds {
  /** owner/repo */
  repo: string
  branch: string
  /** 细粒度 PAT：只勾**你要同步的那一个**私有数据仓的 Contents: Read and write。
   *  它只存在本机 Preferences，**绝不进工作区**（工作区会被推到 GitHub） */
  token: string
}

/** 默认仓库：预填给用户，避免手打出错 */
// 默认留空：仓库名由用户首次配置时填（不在公开代码里写死私有仓的名字）
export const DEFAULT_REPO = ''
export const DEFAULT_BRANCH = 'main'

/** 上次同步的记账：判断"哪一侧变了"靠它，没有它就只能退回前缀判定 */
export interface SyncBase {
  /** 上次同步后的分支头 commit（推送时的 parent 与冲突检测基准） */
  commit: string | null
  /** 上次同步后各文件在远端的 blob sha */
  remoteSha: Record<string, string>
  /** 上次同步后各文件在本地的内容指纹 */
  localHash: Record<string, string>
  /**
   * 上次同步判过"不能自动合并"、至今没对齐的文件。
   *
   * 为什么必须记下来：这些文件一旦只是"这次跳过"，下次同步在记账看就是"两侧都没变"
   * （甚至会被读成"本地新建的文件"）→ 静默跳过或被本机那份推上去盖掉远端，分叉永远不收敛。
   * 记下来后每次都会按"祖先未知"重新判定，直到真的对齐（或用户手动用远端覆盖）。
   */
  conflicts?: string[]
}

export function emptyBase(): SyncBase {
  return { commit: null, remoteSha: {}, localHash: {}, conflicts: [] }
}

/** 一次同步的结果（同步结果页与设置页都读它） */
export interface SyncReport {
  ok: boolean
  at: number
  /** 一句话结论 */
  message: string
  /** 逐文件说明：为什么推/拉/跳过/拦下 */
  files: { path: string; action: string; reason: string }[]
  pushed: number
  pulled: number
  reviews: number
  cards: number
  commit: string | null
  /** 快照目录名（推送前备份的位置） */
  snapshot?: string
}

export interface SyncDeps {
  client: GithubClient
}
