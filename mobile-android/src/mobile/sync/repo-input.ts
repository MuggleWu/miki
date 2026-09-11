// 仓库标识的解析与归一化。
//
// 为什么单独做一层：用户在浏览器地址栏里看到的是
// `https://github.com/<owner>/<repo>.git`，而 Git Data API 的路径要的是 `<owner>/<repo>`。
// 直接把前者拼进 `/repos/...` 会得到一个合法但必然 404 的请求，报错还看不出是人填错了——
// 这正是"配置完点了保存、只回一句连接失败"的典型来源。所以：
//   ① 尽量把用户手上那串东西认出来（URL / scp 形式 / 裸 owner/repo 都收）；
//   ② 认不出来就**明确拒绝**，并说清应该填什么，而不是拼一串乱码去打 API。

export type RepoProblem =
  /** 什么都没填 */
  | 'empty'
  /** 看着像把 token 填进了仓库字段 */
  | 'looks-like-token'
  /** 明确不是 GitHub（比如粘贴了别的站点的地址） */
  | 'not-github'
  /** 认不出来 */
  | 'unparsable'

export interface RepoParse {
  /** 归一化后的 owner/repo；解析失败为 null */
  repo: string | null
  problem: RepoProblem | null
}

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com', 'ssh.github.com'])
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/

/** 解析用户输入。成功返回 {repo:'owner/repo'}，失败返回 {repo:null, problem:'原因'} */
export function parseRepoInput(raw: string): RepoParse {
  const trimmed = raw.trim()
  if (trimmed === '') return { repo: null, problem: 'empty' }
  if (/^(github_pat_|ghp_|gho_|ghs_|github_token)/i.test(trimmed) || /^[A-Za-z0-9_]{40,}$/.test(trimmed)) {
    return { repo: null, problem: 'looks-like-token' }
  }

  // 去掉 fragment / query / 末尾斜杠 / .git 后缀
  let s = trimmed
    .split('#')[0]
    .split('?')[0]
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')

  // 协议与 scp 形式
  const schemeMatch = /^(?:https?|git|ssh):\/\//i.exec(s)
  if (schemeMatch) {
    s = s.slice(schemeMatch[0].length)
    s = s.replace(/^[^/@]*@/, '') // 去掉 URL 里的凭据部分（user:token@）
  } else if (/^[^/@]+@[^/]+:/.test(s)) {
    s = s.replace(/^[^/@]+@/, '').replace(':', '/') // git@github.com:owner/repo
  }

  const parts = s.split('/').filter((p) => p !== '')
  if (parts.length === 0) return { repo: null, problem: 'unparsable' }

  // 首段若是主机名就核一下：只支持 GitHub（客户端所有请求都打 api.github.com）
  if (parts[0].includes('.')) {
    const host = parts[0].replace(/:\d+$/, '').toLowerCase()
    if (!GITHUB_HOSTS.has(host)) return { repo: null, problem: 'not-github' }
    parts.shift()
  }

  if (parts.length < 2) return { repo: null, problem: 'unparsable' }
  const [owner, repo] = parts
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) return { repo: null, problem: 'unparsable' }
  return { repo: `${owner}/${repo}`, problem: null }
}

/** 只要结果，不要原因（读到脏的历史值时用） */
export function normalizeRepo(raw: string): string | null {
  return parseRepoInput(raw).repo
}

/** 把解析失败翻成"该填什么"的一句话 */
export function explainRepoProblem(problem: RepoProblem): string {
  switch (problem) {
    case 'empty':
      return '先填仓库：形如 owner/repo，例如 your-name/your-data-repo'
    case 'looks-like-token':
      return '这看起来是 PAT，不是仓库名。仓库填 owner/repo，token 填在下面那一栏'
    case 'not-github':
      return '只支持 GitHub 仓库：地址应当是 github.com 下的 owner/repo'
    default:
      return '看不懂这个仓库标识：可以填 owner/repo，也可以直接粘 https://github.com/owner/repo 这种地址'
  }
}
