// 首次配置同步：仓库 + 分支（折叠在高级里）+ PAT。
//
// 这里刻意把"怎么生成 PAT"写全（三步），因为这是整个方案里唯一必须用户自己在
// GitHub 网页上做的事——写不清楚就会卡在第一步。
//
// 仓库那一栏要能直接吃下浏览器地址栏里那串 URL：用户手上只有那个，让他自己剪成
// owner/repo 是把活推给他，剪错了还只会得到一个看不懂的 404。
import { useState } from 'react'
import { useApp } from '../store'
import { explainRepoProblem, parseRepoInput } from '../../mobile/sync/repo-input'

export function SyncConfigForm({ onDone }: { onDone(): void }): JSX.Element {
  const sync = useApp((s) => s.sync)
  const saveSyncConfig = useApp((s) => s.saveSyncConfig)
  const [repo, setRepo] = useState(sync.status?.repo ?? '')
  const [branch, setBranch] = useState(sync.status?.branch ?? 'main')
  const [token, setToken] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)

  const parsed = parseRepoInput(repo)
  // 已经存过 PAT 时允许留空保存：留空的语义就是"不改 token"（见下面 save 与 creds.ts），
  // 输入框的 placeholder 也是这么写的。少这一支，「只改仓库名」这条最常见的路径会被按钮封死，
  // 用户只能重新贴一遍 PAT——而提示语明写着留空就行。首次配置仍然必须填。
  const configured = sync.status?.configured ?? false
  const canSave = parsed.repo !== null && (token.trim().length > 0 || configured)
  // 认出来了、但填的不是最终形态（比如粘的是整串 URL）→ 明确告诉他会存成什么
  const willStore = parsed.repo && parsed.repo !== repo.trim() ? parsed.repo : null

  async function save(): Promise<void> {
    setBusy(true)
    try {
      // 归一化后保存；留空表示"不改 token"（用户只改仓库时不该被迫重新粘贴）
      await saveSyncConfig(parsed.repo ?? repo, branch, token.trim() === '' ? null : token.trim())
    } finally {
      setBusy(false)
      onDone()
    }
  }

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <label className="field">
        <span>仓库（owner/repo，也可以直接粘仓库地址）</span>
        <input value={repo} onChange={(e) => setRepo(e.target.value)} autoCapitalize="off" autoCorrect="off" />
      </label>
      {parsed.problem && repo.trim() !== '' ? <p className="note">{explainRepoProblem(parsed.problem)}</p> : null}
      {willStore ? <p className="muted">将存为 {willStore}</p> : null}

      <label className="field">
        <span>细粒度 PAT</span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={sync.status?.tokenMask ? `已存 ${sync.status.tokenMask}，留空则不改` : 'github_pat_…'}
          autoCapitalize="off"
          autoCorrect="off"
          // 输入法是能看到你敲/粘贴进去的内容的：device 上的第三方输入法可能把它学进词库。
          // type=password 已经让多数输入法关掉个性化学习，这里再显式关掉自动填充与拼写检查，
          // 免得 token 被存进 WebView 的自动填充里。
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      <details open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
        <summary>高级</summary>
        <label className="field">
          <span>分支</span>
          <input value={branch} onChange={(e) => setBranch(e.target.value)} autoCapitalize="off" autoCorrect="off" />
        </label>
      </details>

      {/* 生成步骤折叠起来：展开时表单比一屏还长，键盘一弹"保存"就落到屏幕外了。
          默认收起 → 三个字段 + 按钮正好一屏，用户不需要先学会滚动。 */}
      <details className="pat-help">
        <summary>怎么生成 PAT？</summary>
        <ol>
          <li>GitHub 网页 → 头像 → Settings → Developer settings</li>
          <li>Fine-grained tokens → Generate new token</li>
          <li>
            Repository access 只勾<b>你那个私有数据仓</b>（只勾这一个）；Permissions 只给
            <b> Contents: Read and write</b>；有效期设长一点
          </li>
        </ol>
        <p className="muted">token 只存这台手机的应用私有存储里，不会进工作区、也不会被推到仓库。</p>
      </details>

      <div className="row-btns">
        <button className="btn" type="button" onClick={onDone}>
          取消
        </button>
        <button className="btn primary" type="submit" disabled={!canSave || busy}>
          {busy ? '验证中…' : '保存并验证'}
        </button>
      </div>
    </form>
  )
}
