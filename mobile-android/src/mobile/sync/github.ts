// GitHub Git Data API 客户端（只用到工作区同步需要的 8 个端点）。
//
// 为什么不用 Contents API 的 PUT：它单文件上限 1MB，而卡片基文件会接近这个量级
// （设计文档已列为已知风险）。Git Data API 走 blob → tree → commit → ref，
// 没有大小限制，而且**一次同步只产生一条 commit**（Contents API 是一个文件一条）。
//
// 推送用的是 fast-forward 语义：updateRef 不带 force。远端在我们读完之后被别人推过
// （桌面端 push），GitHub 会返回 422，我们据此中止而不是强推覆盖——这是"绝不猜测"在
// 网络层的体现。
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import type { SyncCreds } from './types'

const API = 'https://api.github.com'

/**
 * 单个请求的超时。取 30 秒：手机热点或地铁里一次 GitHub 请求偶尔要十几秒，但**永远卡住**
 * 不可接受——同步期间界面是 busy 的，没有超时用户只能杀进程。这是"每个请求"的上限，
 * 一次同步有很多请求，慢网络下总时长仍可能长，但每次失败都能明确报出来并释放 busy。
 */
const REQUEST_TIMEOUT_MS = 30_000

export class GithubError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'GithubError'
  }
}

/** 失败的大类。只为让界面说人话：网络不通 ≠ 凭据不对 ≠ 仓库填错 */
export type FailureKind = 'network' | 'auth' | 'permission' | 'not-found' | 'conflict' | 'other'

/** 网络层失败（fetch 直接抛错，压根没拿到 HTTP 状态）用 -1 表示；0 留给"非 HTTP 的内部错误" */
export const NETWORK_STATUS = -1

export function classifyFailure(status: number, detail: string): FailureKind {
  if (status === NETWORK_STATUS) return 'network'
  if (status === 401) return 'auth'
  if (status === 422) return 'conflict'
  if (status === 403) return /rate limit|secondary rate/i.test(detail) ? 'other' : 'permission'
  if (status === 404) return 'not-found'
  return 'other'
}

/**
 * 把 GitHub 的状态码翻成"下一步该做什么"。
 * 特别注意 404：GitHub 对"仓库不存在"和"这个 token 没被授权访问它"**一律**返回 404，
 * 不区分。用户按字面理解成"仓库名打错了"就会反复改仓库名，实际是 token 的 Repository
 * access 没勾上那个仓库。所以这句话必须把两种可能都写出来。
 */
export function explainFailure(kind: FailureKind, detail: string, repo: string): string {
  const raw = detail ? `（GitHub 原话：${detail}）` : ''
  switch (kind) {
    case 'network':
      return '连不上 api.github.com：手机当前网络到不了 GitHub，这不是凭据问题。换个网络（Wi-Fi / 蜂窝）或走代理再试'
    case 'auth':
      return `PAT 无效或已过期${raw}。去 GitHub 重新生成一个细粒度 token，粘回下面那一栏`
    case 'permission':
      return `这个 PAT 没有做这件事的权限${raw}。检查两处：Repository access 勾了要同步的那个仓；Permissions 给了 Contents: Read and write`
    case 'not-found':
      return `找不到仓库「${repo}」${raw}。两种可能：① 仓库名填错了（要 owner/repo，不是浏览器地址）；② 这个 PAT 没被授权访问它——GitHub 对没权限的私有仓也只回 404，不会告诉你"存在但没权限"`
    case 'conflict':
      return '远端在你读完之后又被推过（不是快进），为避免覆盖已停下。先去桌面端同步一次，再回来重试'
    default:
      return detail || '请求 GitHub 失败'
  }
}

/** 从 GitHub 的错误响应里抠出原话（原生层给的是已解析对象，fetch 路径给的是 JSON 或文本） */
function detailOf(data: unknown): string {
  if (typeof data === 'string') return data.slice(0, 200)
  if (data && typeof data === 'object' && 'message' in data) {
    const m = (data as { message?: unknown }).message
    if (typeof m === 'string') return m
  }
  return ''
}

export interface TreeEntry {
  path: string
  sha: string
  size: number
}

export class GithubClient {
  constructor(private readonly creds: SyncCreds) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${API}${path}`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.creds.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    }

    // ---- 真机：走原生网络层（CapacitorHttp），不用 WebView 的 fetch ----
    //
    // 为什么非换不可：WebView 里这个应用的 origin 是 https://localhost，请求 api.github.com
    // 是跨域；而每个请求都带 Authorization（非"简单请求"），浏览器必须先发一次 OPTIONS 预检
    // 问服务器同不同意。实测：同一个 URL、同一条连接，带 Authorization 一次 650ms，不带 120ms
    // ——差的这 500ms 出头就是预检。一次推送十几个请求，光预检就是五六秒。
    // 原生层直接发 HTTP，没有同源策略，也就没有预检。
    if (Capacitor.isNativePlatform()) {
      let res: { status: number; data: unknown }
      try {
        res = await CapacitorHttp.request({
          url,
          method,
          headers,
          ...(body === undefined ? {} : { data: body }),
          connectTimeout: REQUEST_TIMEOUT_MS,
          readTimeout: REQUEST_TIMEOUT_MS,
          responseType: 'json'
        })
      } catch (e) {
        throw this.networkError(e)
      }
      // 原生层不会因为状态码抛错，4xx/5xx 也要在这里翻成人话
      if (res.status < 200 || res.status >= 300) throw this.httpError(method, path, res.status, res.data)
      return res.data as T
    }

    // ---- 浏览器/测试环境：原来的 fetch 路径（没有 Capacitor 原生层可用）----
    let res: Response
    // 每个请求各自超时：没有超时的话，一次卡住的请求会让界面永远停在"同步中"（busy 只有
    // 在 runSync 返回/抛错时才释放），用户除了杀进程没有别的办法。用 AbortController 而不是
    // AbortSignal.timeout：后者要较新的 WebView，这个应用不假设 WebView 版本。
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS)
    let aborted = false
    try {
      res = await fetch(url, {
        method,
        // 必须显式禁掉 HTTP 缓存：GitHub 的 REST 响应带 `cache-control: private, max-age=60`，
        // WebView 的私有缓存会在这 60 秒内直接复用**没有重新请求**的旧响应。真机演练里就是这么炸的：
        // 一次同步开头读分支头（缓存），40 秒后推送完再读回，拿到的是推送前那个头，
        // 于是"推送成功却报读回不一致"。Node 侧的 undici 没有 HTTP 缓存，所以只有真机看得见。
        cache: 'no-store',
        signal: ac.signal,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      })
    } catch (e) {
      aborted = ac.signal.aborted
      // fetch 抛错 = 压根没拿到 HTTP 响应（DNS/连接/证书/被拦/超时）。这条以前会原样抛成
      // "Failed to fetch"，用户看到四个英文单词，无从判断是网络还是凭据——分开报。
      throw this.networkError(aborted ? new Error('timeout') : e)
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      // 把状态码翻成"下一步做什么"，并保留 GitHub 原话与具体请求，便于排查时不被二次转述失真。
      let data: unknown = null
      try {
        data = await res.json()
      } catch {
        data = await res.text().catch(() => '')
      }
      throw this.httpError(method, path, res.status, data)
    }
    return (await res.json()) as T
  }

  /** 没拿到 HTTP 响应：区分"超时"与"连不上"，别让用户对着 Failed to fetch 猜 */
  private networkError(e: unknown): GithubError {
    const msg = e instanceof Error ? e.message : String(e)
    const timeout = /timeout|timed out|abort/i.test(msg)
    return new GithubError(
      NETWORK_STATUS,
      timeout
        ? `等了 ${Math.round(REQUEST_TIMEOUT_MS / 1000)} 秒没有响应，已放弃这次请求（网络可能断了）。可以稍后重试，本地数据没有被改动。`
        : explainFailure('network', '', this.creds.repo)
    )
  }

  /** 拿到 HTTP 响应但不是 2xx：把状态码翻成"下一步做什么"，并保留 GitHub 原话与具体请求 */
  private httpError(method: string, path: string, status: number, data: unknown): GithubError {
    const detail = detailOf(data)
    const kind = classifyFailure(status, detail)
    return new GithubError(
      status,
      `${explainFailure(kind, detail, this.creds.repo)}［${method} ${path} → HTTP ${status}］`
    )
  }

  /** 凭据与仓库可达性验证（设置页的"验证连接"用） */
  async verify(): Promise<{ ok: boolean; message: string; kind: FailureKind | null }> {
    try {
      const repo = await this.req<{ full_name: string; private: boolean; default_branch: string }>(
        'GET',
        `/repos/${this.creds.repo}`
      )
      const head = await this.head()
      return {
        ok: true,
        message: `${repo.full_name}（${repo.private ? '私有' : '公开'}）分支 ${this.creds.branch} @ ${head.slice(0, 7)}`,
        kind: null
      }
    } catch (e) {
      const status = e instanceof GithubError ? e.status : 0
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
        kind: classifyFailure(status, e instanceof Error ? e.message : '')
      }
    }
  }

  /** 分支头：commit sha 与它的 tree sha（推送时作为 base_tree） */
  /**
   * 分支头 commit。**只要 1 个请求**：tree 不是每次都要（"远端没变"的一次拉取完全不碰它），
   * 所以拆出去放在 treeOf 里按需取。以前这里连带把 commit 也读了，每次同步开头就多一个请求。
   */
  async head(): Promise<string> {
    const ref = await this.req<{ object: { sha: string } }>(
      'GET',
      `/repos/${this.creds.repo}/git/ref/heads/${this.creds.branch}`
    )
    return ref.object.sha
  }

  /** 某个 commit 的 tree sha（1 个请求）。列文件树、建新树时才需要 */
  async treeOf(commit: string): Promise<string> {
    const c = await this.req<{ tree: { sha: string } }>('GET', `/repos/${this.creds.repo}/git/commits/${commit}`)
    return c.tree.sha
  }

  /** 一次取回整棵树（不递归子目录请求，仓库只有三层） */
  async listFiles(treeSha: string): Promise<TreeEntry[]> {
    const res = await this.req<{
      tree: { path: string; type: string; sha: string; size?: number }[]
      truncated: boolean
    }>('GET', `/repos/${this.creds.repo}/git/trees/${treeSha}?recursive=1`)
    if (res.truncated) throw new GithubError(0, '远端文件树被截断（文件过多），当前实现不支持这么大的仓库')
    return res.tree.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 }))
  }

  /** 读一个文件（base64 → 文本）。NDJSON 是 UTF-8 文本，这里按文本解码 */
  async readFile(sha: string): Promise<string> {
    const blob = await this.req<{ content: string; encoding: string }>(
      'GET',
      `/repos/${this.creds.repo}/git/blobs/${sha}`
    )
    if (blob.encoding !== 'base64') throw new GithubError(0, `未知的 blob 编码：${blob.encoding}`)
    const bin = atob(blob.content.replace(/\n/g, ''))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  }

  /** 写一个文件：内容 → blob sha（推送的第一步） */
  async writeBlob(text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text)
    // 分块拼二进制字符串：逐字节 `bin += ...` 在 2.6MB 的复习日志上实测 206ms，分块只要 25ms
    // （块大小 8192 是 String.fromCharCode.apply 的安全上限附近，再大容易爆调用栈）
    let bin = ''
    const CHUNK = 8192
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[])
    }
    const res = await this.req<{ sha: string }>('POST', `/repos/${this.creds.repo}/git/blobs`, {
      content: btoa(bin),
      encoding: 'base64'
    })
    return res.sha
  }

  async createTree(baseTree: string, files: { path: string; sha: string }[]): Promise<string> {
    const res = await this.req<{ sha: string }>('POST', `/repos/${this.creds.repo}/git/trees`, {
      base_tree: baseTree,
      tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', sha: f.sha }))
    })
    return res.sha
  }

  async createCommit(message: string, tree: string, parent: string): Promise<string> {
    const res = await this.req<{ sha: string }>('POST', `/repos/${this.creds.repo}/git/commits`, {
      message,
      tree,
      parents: [parent]
    })
    return res.sha
  }

  /** 更新分支头。force 恒为 false：不是 fast-forward 就让 GitHub 拒绝（422），由调用方报冲突 */
  async updateRef(commit: string): Promise<void> {
    await this.req('PATCH', `/repos/${this.creds.repo}/git/refs/heads/${this.creds.branch}`, {
      sha: commit,
      force: false
    })
  }
}
