// GitHub Git Data API 客户端（只用到工作区同步需要的 8 个端点）。
//
// 为什么不用 Contents API 的 PUT：它单文件上限 1MB，而卡片基文件会接近这个量级
// （设计文档已列为已知风险）。Git Data API 走 blob → tree → commit → ref，
// 没有大小限制，而且**一次同步只产生一条 commit**（Contents API 是一个文件一条）。
//
// 推送用的是 fast-forward 语义：updateRef 不带 force。远端在我们读完之后被别人推过
// （桌面端 push），GitHub 会返回 422，我们据此中止而不是强推覆盖——这是"绝不猜测"在
// 网络层的体现。
import type { SyncCreds } from './types'

const API = 'https://api.github.com'

export class GithubError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'GithubError'
  }
}

export interface TreeEntry {
  path: string
  sha: string
  size: number
}

export class GithubClient {
  constructor(private readonly creds: SyncCreds) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.creds.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    })
    if (!res.ok) {
      // 401/403 是凭据问题（要引导用户去换 token），422 是 fast-forward 失败（冲突），
      // 其余按普通失败处理。错误信息里带上 GitHub 的原话，避免我们二次转述失真。
      let detail = ''
      try {
        const j = (await res.json()) as { message?: string }
        detail = j.message ?? ''
      } catch {
        detail = await res.text().catch(() => '')
      }
      throw new GithubError(res.status, `GitHub ${method} ${path} 失败（${res.status}）：${detail}`)
    }
    return (await res.json()) as T
  }

  /** 凭据与仓库可达性验证（设置页的"验证连接"用） */
  async verify(): Promise<{ ok: boolean; message: string }> {
    try {
      const repo = await this.req<{ full_name: string; private: boolean; default_branch: string }>(
        'GET',
        `/repos/${this.creds.repo}`
      )
      const ref = await this.req<{ object: { sha: string } }>(
        'GET',
        `/repos/${this.creds.repo}/git/ref/heads/${this.creds.branch}`
      )
      return {
        ok: true,
        message: `${repo.full_name}（${repo.private ? '私有' : '公开'}）分支 ${this.creds.branch} @ ${ref.object.sha.slice(0, 7)}`
      }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }

  /** 分支头：commit sha 与它的 tree sha（推送时作为 base_tree） */
  async head(): Promise<{ commit: string; tree: string }> {
    const ref = await this.req<{ object: { sha: string } }>(
      'GET',
      `/repos/${this.creds.repo}/git/ref/heads/${this.creds.branch}`
    )
    const commit = await this.req<{ tree: { sha: string } }>(
      'GET',
      `/repos/${this.creds.repo}/git/commits/${ref.object.sha}`
    )
    return { commit: ref.object.sha, tree: commit.tree.sha }
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
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
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
