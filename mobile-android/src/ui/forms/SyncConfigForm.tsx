// 首次配置同步：仓库 + 分支（折叠在高级里）+ PAT。
//
// 这里刻意把"怎么生成 PAT"写全（三步），因为这是整个方案里唯一必须用户自己在
// GitHub 网页上做的事——写不清楚就会卡在第一步。
import { useState } from 'react'
import { useApp } from '../store'

export function SyncConfigForm({ onDone }: { onDone(): void }): JSX.Element {
  const sync = useApp((s) => s.sync)
  const saveSyncConfig = useApp((s) => s.saveSyncConfig)
  const [repo, setRepo] = useState(sync.status?.repo ?? 'MuggleWu/miki-base')
  const [branch, setBranch] = useState(sync.status?.branch ?? 'main')
  const [token, setToken] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)

  const canSave = repo.trim().includes('/') && token.trim().length > 0

  async function save(): Promise<void> {
    setBusy(true)
    try {
      // 留空表示"不改 token"：用户只改仓库时不该被迫重新粘贴
      await saveSyncConfig(repo, branch, token.trim() === '' ? null : token.trim())
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
        <span>仓库（owner/repo）</span>
        <input value={repo} onChange={(e) => setRepo(e.target.value)} autoCapitalize="off" autoCorrect="off" />
      </label>

      <label className="field">
        <span>细粒度 PAT</span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={sync.status?.tokenMask ? `已存 ${sync.status.tokenMask}，留空则不改` : 'github_pat_…'}
          autoCapitalize="off"
          autoCorrect="off"
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
            Repository access 只勾 <code>MuggleWu/miki-base</code>；Permissions 只给
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
