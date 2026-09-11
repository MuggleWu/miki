// 同步凭据与同步记账的读写。
//
// 两条硬规则，代码结构上就别留出错的空间：
//   ① PAT 只在这里进出，**任何返回给 UI 的凭据都带脱敏形态**（`github_pat_****abcd`），
//      页面拿不到原文，也就不可能把它渲染出来或写进日志。
//   ② 凭据只进 Capacitor Preferences（应用私有 SharedPreferences），绝不进工作区——
//      工作区会被整份推到 GitHub，token 跟着就泄露了。
import { PREF_KEYS, prefGet, prefRemove, prefSet } from '../prefs'
import { DEFAULT_BRANCH, DEFAULT_REPO, emptyBase, type SyncBase } from './types'

export interface SyncCredsStatus {
  repo: string
  branch: string
  /** 脱敏后的 token（只为显示"存了哪一个"，不是可用的凭据） */
  tokenMask: string | null
  configured: boolean
}

export interface VerifyRecord {
  at: number
  ok: boolean
  message: string
}

/** token 脱敏：只留前缀与末 4 位。PAT 长度短于 8 位时全遮 */
export function maskToken(token: string | null): string | null {
  if (!token) return null
  if (token.length < 8) return '****'
  return `${token.slice(0, 4)}****${token.slice(-4)}`
}

export async function loadCreds(): Promise<{ repo: string; branch: string; token: string | null }> {
  const repo = (await prefGet(PREF_KEYS.githubRepo)) ?? DEFAULT_REPO
  const branch = (await prefGet(PREF_KEYS.githubBranch)) ?? DEFAULT_BRANCH
  const token = await prefGet(PREF_KEYS.githubPat)
  return { repo, branch, token }
}

export async function credsStatus(): Promise<SyncCredsStatus> {
  const { repo, branch, token } = await loadCreds()
  return { repo, branch, tokenMask: maskToken(token), configured: token !== null && token.length > 0 }
}

export async function saveCreds(repo: string, branch: string, token: string | null): Promise<void> {
  await prefSet(PREF_KEYS.githubRepo, repo.trim())
  await prefSet(PREF_KEYS.githubBranch, branch.trim() || DEFAULT_BRANCH)
  if (token !== null && token.trim() !== '') await prefSet(PREF_KEYS.githubPat, token.trim())
}

/** 清空凭据：PAT 立刻删掉，仓库名留着（下次重填少打一次字是合理的） */
export async function clearCreds(): Promise<void> {
  await prefRemove(PREF_KEYS.githubPat)
}

export async function loadBase(): Promise<SyncBase> {
  const raw = await prefGet(PREF_KEYS.syncBase)
  if (!raw) return emptyBase()
  try {
    const parsed = JSON.parse(raw) as Partial<SyncBase>
    return {
      commit: parsed.commit ?? null,
      remoteSha: parsed.remoteSha ?? {},
      localHash: parsed.localHash ?? {}
    }
  } catch {
    // 记账坏了不影响正确性，只是退化成"没有 base"（前缀判定），不能让它把同步带崩
    return emptyBase()
  }
}

export async function saveBase(base: SyncBase): Promise<void> {
  await prefSet(PREF_KEYS.syncBase, JSON.stringify(base))
}

export async function loadVerify(): Promise<VerifyRecord | null> {
  const raw = await prefGet(PREF_KEYS.syncVerify)
  if (!raw) return null
  try {
    return JSON.parse(raw) as VerifyRecord
  } catch {
    return null
  }
}

export async function saveVerify(v: VerifyRecord): Promise<void> {
  await prefSet(PREF_KEYS.syncVerify, JSON.stringify(v))
}

export async function saveLastSyncAt(at: number): Promise<void> {
  await prefSet(PREF_KEYS.lastSyncAt, String(at))
}

export async function loadLastSyncAt(): Promise<number | null> {
  const raw = await prefGet(PREF_KEYS.lastSyncAt)
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) ? n : null
}
