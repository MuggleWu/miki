// 同步凭据与同步记账的读写。
//
// 两条硬规则，代码结构上就别留出错的空间：
//   ① PAT 只在这里进出，**任何返回给 UI 的凭据都带脱敏形态**（`github_pat_****abcd`），
//      页面拿不到原文，也就不可能把它渲染出来或写进日志。
//   ② 凭据只进 Capacitor Preferences（应用私有 SharedPreferences），绝不进工作区——
//      工作区会被整份推到 GitHub，token 跟着就泄露了。
import { PREF_KEYS, prefGet, prefRemove, prefSet } from '../prefs'
import type { FailureKind } from './github'
import { normalizeRepo } from './repo-input'
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
  /** 失败大类：界面据此区分"网络不通"和"凭据/仓库不对"，不把它们混成一句"凭据失效" */
  kind?: FailureKind | null
}

/** token 脱敏：只留前缀与末 4 位。PAT 长度短于 8 位时全遮 */
export function maskToken(token: string | null): string | null {
  if (!token) return null
  if (token.length < 8) return '****'
  return `${token.slice(0, 4)}****${token.slice(-4)}`
}

export async function loadCreds(): Promise<{ repo: string; branch: string; token: string | null }> {
  const raw = (await prefGet(PREF_KEYS.githubRepo)) ?? DEFAULT_REPO
  // 读的时候也归一化一遍：早期版本允许把浏览器地址整串存进来，那种值只会在 API 层
  // 变成一个必然 404 的路径。存量脏值在这里就地救回，不用让用户重新手打一遍。
  const repo = normalizeRepo(raw) ?? raw
  const branch = (await prefGet(PREF_KEYS.githubBranch)) ?? DEFAULT_BRANCH
  const token = await prefGet(PREF_KEYS.githubPat)
  return { repo, branch, token }
}

export async function credsStatus(): Promise<SyncCredsStatus> {
  const { repo, branch, token } = await loadCreds()
  return { repo, branch, tokenMask: maskToken(token), configured: token !== null && token.length > 0 }
}

export async function saveCreds(repo: string, branch: string, token: string | null): Promise<void> {
  // 存之前归一化：能认出来的就存成 owner/repo，认不出来的原样留着（界面会提示该填什么）
  await prefSet(PREF_KEYS.githubRepo, normalizeRepo(repo) ?? repo.trim())
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

/**
 * 作废同步记账（换仓库/换分支时必须调）。
 *
 * 记账是按「仓库 + 分支」记的：换了目标却留着旧 base，新仓库里**不存在**的文件会走
 * `?? baseRemoteSha` 兜底，被判成「远端有这个文件且内容没变」→ skip；随后 base 又被
 * 重写成新仓库的 head + 当前本地指纹，于是之后每次都继续 skip —— 本地数据永远推不上去，
 * 而界面一直报「已是最新」。宁可退化成"没有 base"（全量比一遍），也不能安静地假备份。
 */
export async function clearBase(): Promise<void> {
  await prefRemove(PREF_KEYS.syncBase)
  // 连接验证是上一次目标的结果，留着会显示成新仓库的「已验证」
  await prefRemove(PREF_KEYS.syncVerify)
}

/**
 * 保存同步目标（仓库/分支/PAT）并处理"换目标"的后果。
 *
 * 单独成函数（而不是塞在 UI store 里）是为了能被测试：这条链上最容易出错的一步
 * ——「换了仓库却没作废记账」——必须由测试钉住，而不是靠人记得调 clearBase。
 * token 传 null = 不改已存的 PAT（表单留空就是这个语义）。
 */
export async function applySyncConfig(
  repo: string,
  branch: string,
  token: string | null
): Promise<{ switched: boolean; creds: { repo: string; branch: string; token: string | null } }> {
  const before = await loadCreds()
  await saveCreds(repo, branch, token)
  const creds = await loadCreds()
  const switched = before.repo !== creds.repo || before.branch !== creds.branch
  if (switched) await clearBase()
  return { switched, creds }
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
