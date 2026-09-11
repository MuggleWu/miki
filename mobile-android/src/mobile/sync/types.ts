// 同步相关的类型与常量（客户端与编排层共用，避免循环引用）
import type { GithubClient } from './github'

export interface SyncCreds {
  /** owner/repo */
  repo: string
  branch: string
  /** 细粒度 PAT：只勾 miki-base 一个仓库的 Contents: Read and write。
   *  它只存在本机 Preferences，**绝不进工作区**（工作区会被推到 GitHub） */
  token: string
}

/** 默认仓库：预填给用户，避免手打出错 */
export const DEFAULT_REPO = 'MuggleWu/miki-base'
export const DEFAULT_BRANCH = 'main'

/** 上次同步的记账：判断"哪一侧变了"靠它，没有它就只能退回前缀判定 */
export interface SyncBase {
  /** 上次同步后的分支头 commit（推送时的 parent 与冲突检测基准） */
  commit: string | null
  /** 上次同步后各文件在远端的 blob sha */
  remoteSha: Record<string, string>
  /** 上次同步后各文件在本地的内容指纹 */
  localHash: Record<string, string>
}

export function emptyBase(): SyncBase {
  return { commit: null, remoteSha: {}, localHash: {} }
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
