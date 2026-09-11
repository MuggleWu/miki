// 同步编排：拉取 → 行合并 → 本地落地 → 重放校验 → 快照 → 推送 → 读回。
//
// 顺序与理由是设计文档定的（「同步协议」节），这里只补实现上的取舍：
//   · 远端只下载"sha 变了的文件"、本地只推送"内容变了或合并过的文件"——
//     否则每次同步都要搬整个工作区。
//   · 合并落地后**先重放校验再推送**：校验不过就地停止，不留下"本地已改、远端没推"的
//     半截状态，也不产生一条可能推错内容的 commit。
//   · 推送前快照（保留最近 5 次），合并异常或推送失败都能退回去。
//   · updateRef 用 fast-forward：远端在我们读取之后被别人推过时，GitHub 直接拒，
//     我们不覆盖别人的提交。
import { GithubClient } from './github'
import { mergeFile, type MergeResult } from './merge'
import { emptyBase, type SyncBase, type SyncCreds, type SyncReport } from './types'
import type { FileStore } from '../fs/types'
import type { MobilePaths } from '../paths'

/** 工作区里参与同步的文件（config.json 只读不写：机器本地字段归桌面端管） */
export function isSyncable(path: string): boolean {
  if (path.endsWith('stats.json')) return false // 派生缓存，桌面端也不进仓库
  return path === 'decks.json' || path === 'config.json' || path.endsWith('.ndjson')
}

/** 递归列出工作区文件（相对 root 的 POSIX 路径） */
export async function listWorkspaceFiles(store: FileStore, paths: MobilePaths): Promise<string[]> {
  const out: string[] = []
  for (const f of ['decks.json', 'config.json']) {
    if ((await store.readText(`${paths.root}/${f}`)) !== null) out.push(f)
  }
  for (const dir of ['cards', 'review-log']) {
    for (const e of await store.list(`${paths.root}/${dir}`)) {
      if (e.type === 'file' && isSyncable(e.name)) out.push(`${dir}/${e.name}`)
    }
  }
  return out.sort()
}

/** 内容指纹：判断"本地这份自上次同步后动过没有"。用 SHA-256，不用自造的短哈希——
 *  这里判错的后果是"以为没变"，直接把改动静默跳过 */
export async function hashText(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface SyncEnv {
  store: FileStore
  paths: MobilePaths
  /** 落地后重载工作区并回报校验数据（重放校验的"重放"这一半） */
  reloadAndVerify: () => Promise<{ eventCount: number; damaged: number; truncated: number; cards: number }>
}

export interface SyncOutcome {
  report: SyncReport
  base: SyncBase
}

/**
 * 同步方向。**故意做成必填、且不给默认值**：
 * - `'pull-only'`：只拉，绝不产生 commit。回到前台的自动同步走这条。
 * - `'full'`：拉 + 推。只有用户点"推送进度 / 立即同步"才走这条。
 *
 * 之前这里没有这个参数，回前台那次也照样执行推送段——用户看到的是"说好只拉，结果把我
 * 本机的进度也推上去了"。加上参数并不够，所以不留默认值：漏传时编译就过不去。
 */
export type SyncMode = 'full' | 'pull-only'

/** 一次同步。任何一步失败都抛出，由 UI 层转成提示；不吞异常 */
export async function runSync(env: SyncEnv, creds: SyncCreds, base: SyncBase, mode: SyncMode): Promise<SyncOutcome> {
  const client = new GithubClient(creds)
  const at = Date.now()
  const head = await client.head()

  const files: MergeResult[] = []
  /** 远端变了、这次没取过来的文件（只拉模式下会让记账的 commit 停在原地） */
  const remotePending: string[] = []
  const localOf = async (p: string): Promise<string | null> => env.store.readText(`${env.paths.root}/${p}`)

  // 远端没有动过（头一致）时不必下载任何文件，直接看本地有什么要推的
  const remoteChanged = base.commit !== head.commit
  const remoteFiles = remoteChanged ? (await client.listFiles(head.tree)).filter((e) => isSyncable(e.path)) : []
  /** path → 远端 blob sha（rEntry 就是它，读文件要用） */
  const remoteSha = new Map(remoteFiles.map((e) => [e.path, e.sha]))
  const localPaths = await listWorkspaceFiles(env.store, env.paths)
  const allPaths = [...new Set([...localPaths, ...remoteFiles.map((e) => e.path)])].sort()

  /** 拉下来的新内容（path → 文本），落地与推送都用它 */
  const pulled = new Map<string, string>()
  /** path → 远端 blob sha（含"头没变、这次没列远端"时沿用的上次记录） */
  const remoteShaOf = new Map<string, string>([
    ...Object.entries(base.remoteSha),
    ...remoteFiles.map((e) => [e.path, e.sha] as [string, string])
  ])

  for (const path of allPaths) {
    const local = localPaths.includes(path) ? await localOf(path) : null
    const baseRemoteSha = base.remoteSha[path] ?? null
    // 头没变时不会去列远端文件，所以这里要区分"远端真没有"与"这次没查"：
    // base 记过它，就说明远端有这个文件，只是内容与上次同步时一样
    const rEntry = remoteSha.get(path) ?? baseRemoteSha
    const lastLocal = base.localHash[path] ?? null

    const remoteDiffers = rEntry !== null && rEntry !== baseRemoteSha
    const localDiffers = local !== null && (lastLocal === null || (await hashText(local)) !== lastLocal)

    // 两侧都没动 → 跳过，且**不下载**（卡片基文件可能有几百 KB，每次同步都拉一遍是浪费）
    if (rEntry !== null && !remoteDiffers && !localDiffers) {
      files.push({ path, action: 'skip', content: null, reason: '两侧自上次同步后都没改' })
      continue
    }
    if (rEntry === null && !localDiffers && lastLocal !== null) {
      files.push({ path, action: 'skip', content: null, reason: '本地未改，远端本就没有这个文件' })
      continue
    }

    // 要到"要不要合并、新增了几行"这个层面，就得看远端内容了。
    // 只对"至少一侧变过"的文件读，未动的文件在上面已经跳过。
    const remote = rEntry === null ? null : (pulled.get(path) ?? (await client.readFile(rEntry)))
    if (remote !== null) pulled.set(path, remote)

    // 一方变了：不需要行合并，直接取变的那一方（内容仍走同一套判定函数，理由可追溯）
    const onlyRemote = remoteDiffers && !localDiffers
    const onlyLocal = localDiffers && !remoteDiffers
    const r = onlyRemote
      ? mergeFile({ path, local, remote, base: local })
      : onlyLocal
        ? mergeFile({ path, local, remote, base: remote })
        : mergeFile({ path, local, remote })
    files.push(r)
    // 远端变了、但这次结果不是"直接取远端"（要合并 / 冲突 / 拦住）：留给手动推送处理
    if (remoteDiffers && r.action !== 'take-remote') remotePending.push(path)
  }

  // 只拉模式下遇到不能自动合并的文件不算错误：推送本来就不会发生，把它留着不动，
  // 其它文件照拉——用户下次手动推送时再一起处理。
  const blocked = mode === 'full' ? files.filter((f) => f.action === 'blocked') : []
  if (blocked.length > 0) {
    return {
      base,
      report: {
        ok: false,
        at,
        message: `有 ${blocked.length} 个文件不能自动合并，已停止同步（没有改动任何数据）。`,
        files: files.map((f) => ({ path: f.path, action: f.action, reason: f.reason })),
        pushed: 0,
        pulled: 0,
        reviews: 0,
        cards: 0,
        commit: null
      }
    }
  }

  // ---- 落地：把结果写进本地工作区 ----
  // 只拉模式只写"直接取远端"（take-remote）的文件：合并结果（union）不与推送分离——
  // 那种文件的本地版本会与远端分叉，必须由手动推送一并推上去，静默拉取不碰它。
  const toWrite =
    mode === 'pull-only'
      ? files.filter((f) => f.action === 'take-remote' && f.content !== null)
      : files.filter((f) => f.content !== null)
  for (const f of toWrite) {
    await env.store.writeText(`${env.paths.root}/${f.path}`, f.content!)
  }

  // ---- 重放校验：写下去的东西必须被工作区完整吃进去 ----
  // 没有写入就不必整份重载工作区（回前台那次同步以前每次都白重载一遍）
  if (toWrite.length > 0) {
    const verify = await env.reloadAndVerify()
    if (verify.damaged > 0 || verify.truncated > 0) {
      throw new Error(
        `合并后重放发现坏行（坏行 ${verify.damaged} 条、截断文件 ${verify.truncated} 个），已停止同步。` +
          '请到设置页的「数据健康」看是哪个文件。'
      )
    }
    // 本地事件数必须覆盖本次落地的**事件行**（只有 review-log 里的行才是事件；
    // decks.json / 卡片文件的行不是事件，混进来会让这条校验永远误报）
    const expectedEvents = files.reduce(
      (n, f) => n + (f.content && f.path.startsWith('review-log/') ? countEvents(f.content) : 0),
      0
    )
    if (expectedEvents > 0 && verify.eventCount < expectedEvents) {
      throw new Error(`合并后重放只吃到 ${verify.eventCount} 条事件，少于写入的 ${expectedEvents} 条，已停止同步。`)
    }
  }

  // ---- 只拉模式到此为止：绝不产生 commit，记账按"实际拉到了什么"更新 ----
  if (mode === 'pull-only') {
    // 记账：以上次那份为底，只把这次真正拉下来的文件更新掉。
    // 只要还有"远端变了、这次没取过来"的文件，commit 就停在原地——推进了的话，
    // 下次同步会以为"远端没变过"，那些文件的远端改动就再也拉不回来了。
    const nextRemoteSha = { ...base.remoteSha }
    const nextLocalHash = { ...base.localHash }
    if (remoteChanged && remotePending.length === 0) {
      // 远端清单这次列全了、也没有留下没处理的：直接用这份清单，
      // 顺带清掉远端已删文件的旧记录，免得上一次删除永远留在记账里
      for (const k of Object.keys(nextRemoteSha)) delete nextRemoteSha[k]
      for (const e of remoteFiles) nextRemoteSha[e.path] = e.sha
    }
    for (const f of toWrite) {
      const sha = remoteShaOf.get(f.path)
      if (sha) nextRemoteSha[f.path] = sha
      const text = await env.store.readText(`${env.paths.root}/${f.path}`)
      if (text !== null) nextLocalHash[f.path] = await hashText(text)
    }
    return {
      base: {
        commit: remotePending.length === 0 ? head.commit : base.commit,
        remoteSha: nextRemoteSha,
        localHash: nextLocalHash
      },
      report: {
        ok: true,
        at,
        message:
          toWrite.length > 0
            ? `自动拉取：更新 ${toWrite.length} 个文件（只拉不推，没有产生 commit）`
            : '已是最新，无需改动（只拉不推）',
        files: files.map((f) => ({ path: f.path, action: f.action, reason: f.reason })),
        pulled: toWrite.length,
        pushed: 0,
        reviews: 0,
        cards: 0,
        commit: null
      }
    }
  }

  // ---- 推送 ----
  const toPush = files.filter((f) => f.action === 'keep-local' || f.action === 'union')
  const pushedPaths: string[] = []
  let commit: string | null = null

  if (toPush.length > 0) {
    // 推送前快照：合并异常或推送失败时能退回去
    const snapshot = await snapshotWorkspace(env)

    const shaOf = async (p: string): Promise<string> => {
      const text = (await env.store.readText(`${env.paths.root}/${p}`)) ?? ''
      return client.writeBlob(text)
    }
    const blobs: { path: string; sha: string }[] = []
    for (const f of toPush) {
      blobs.push({ path: f.path, sha: await shaOf(f.path) })
      pushedPaths.push(f.path)
    }

    // 计数只对**要推的那几个**文件算：contents 是按 toPush 生成的数组，
    // 早先这里传的是 files（全量），于是 contents[i] 与 files[i] 根本不是同一个文件，
    // 结果 commit message 永远写 0（真机演练里推了 2 条答题却写着 "0 reviews"）。
    const stats = countLinesToPush(toPush, await Promise.all(toPush.map(async (f) => await localOf(f.path))))
    const message = `mobile: sync ${new Date(at).toISOString().slice(0, 16)} (${stats.reviews} reviews, ${stats.cards} cards)`

    const tree = await client.createTree(head.tree, blobs)
    commit = await client.createCommit(message, tree, head.commit)
    await client.updateRef(commit) // 非 fast-forward 时 GitHub 返回 422 → 抛冲突

    // 读回：确认分支头真的到了我们推的 commit，且改动文件的 blob 就是刚写的那几个
    const after = await client.head()
    if (after.commit !== commit) throw new Error('推送后读回的分支头与预期不一致，请到 GitHub 上确认仓库状态')
    const afterTree = await client.listFiles(after.tree)
    for (const b of blobs) {
      const got = afterTree.find((e) => e.path === b.path)
      if (!got || got.sha !== b.sha) throw new Error(`推送后读回的文件 ${b.path} 与写入的不一致`)
    }

    const nextBase = await buildBase(env, creds, client, after.commit, allPaths)
    return {
      base: nextBase,
      report: {
        ok: true,
        at,
        message:
          `已同步：推送 ${pushedPaths.length} 个文件（${stats.reviews} 条答题、${stats.cards} 张卡）` +
          (toWrite.length > 0 ? `，拉取 ${toWrite.length} 个文件` : ''),
        files: files.map((f) => ({ path: f.path, action: f.action, reason: f.reason })),
        pushed: pushedPaths.length,
        pulled: toWrite.length,
        reviews: stats.reviews,
        cards: stats.cards,
        commit,
        snapshot
      }
    }
  }

  // 只拉取（没有要推的）：远端头已经是我们读到的那个 commit，记账直接更新
  const nextBase = await buildBase(env, creds, client, head.commit, allPaths)
  return {
    base: nextBase,
    report: {
      ok: true,
      at,
      message:
        toWrite.length > 0 ? `已拉取 ${toWrite.length} 个文件（本地无新内容，未产生 commit）` : '已是最新，无需改动',
      files: files.map((f) => ({ path: f.path, action: f.action, reason: f.reason })),
      pushed: 0,
      pulled: toWrite.length,
      reviews: 0,
      cards: 0,
      commit: null
    }
  }
}

/** 记账：把"这次同步后两侧的状态"记下来，下次判定"谁变了"靠它 */
async function buildBase(
  env: SyncEnv,
  _creds: SyncCreds,
  client: GithubClient,
  commit: string,
  paths: string[]
): Promise<SyncBase> {
  const head = await client.head()
  const tree = await client.listFiles(head.tree)
  const remoteSha: Record<string, string> = {}
  for (const e of tree) if (isSyncable(e.path)) remoteSha[e.path] = e.sha
  const localHash: Record<string, string> = {}
  for (const p of paths) {
    const text = await env.store.readText(`${env.paths.root}/${p}`)
    if (text !== null) localHash[p] = await hashText(text)
  }
  return { commit, remoteSha, localHash }
}

/** 推送内容里有多少答题事件、多少卡片行（写进 commit message，方便回看） */
function countLinesToPush(files: MergeResult[], contents: (string | null)[]): { reviews: number; cards: number } {
  let reviews = 0
  let cards = 0
  files.forEach((f, i) => {
    if (f.action !== 'keep-local' && f.action !== 'union') return
    const text = contents[i]
    if (!text) return
    // 用 detail.appended（本次新增的行）而不是整文件行数：
    // commit message 说的是"这次推了什么"，写整份行数会让人以为每次都在重推全量
    const added = f.detail?.appended ?? (text.trim() ? text.trim().split('\n').length : 0)
    if (f.path.startsWith('review-log/')) reviews += added
    if (f.path.startsWith('cards/')) cards += added
  })
  return { reviews, cards }
}

/** 文本里的 NDJSON 行数（只数非空行；坏行留到重放校验里拦） */
function countEvents(text: string): number {
  return text.split('\n').filter((l) => l.trim().length > 0).length
}

/**
 * 推送前快照：整份工作区复制到 `<root>-backups/<时间戳>/`，保留最近 5 份。
 * 放在工作区**外面**——放里面会被下一次同步推上去，把仓库撑爆。
 */
export async function snapshotWorkspace(env: SyncEnv, keep = 5): Promise<string> {
  const root = env.paths.root
  const backupsDir = `${root}-backups`
  const name = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const files = await listWorkspaceFiles(env.store, env.paths)
  for (const p of files) {
    const text = await env.store.readText(`${root}/${p}`)
    if (text !== null) await env.store.writeText(`${backupsDir}/${name}/${p}`, text)
  }
  const existing = (await env.store.list(backupsDir))
    .filter((e) => e.type === 'directory')
    .map((e) => e.name)
    .sort()
  for (const old of existing.slice(0, Math.max(0, existing.length - keep))) {
    await env.store.remove(`${backupsDir}/${old}`)
  }
  return name
}

export { emptyBase }
export type { SyncBase, SyncCreds, SyncReport }
