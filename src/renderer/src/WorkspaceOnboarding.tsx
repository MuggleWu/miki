// 首次启动工作区引导：无有效工作区指针时接管主窗口。用户任选文件夹（名称/位置不限），
// 确认后主进程创建并初始化该工作区，本页让位主界面。多人共用电脑时每人一个文件夹，之后在设置页增删切换
import { useEffect, useState } from 'react'
import type { WorkspaceStatus } from '../../shared/workspace'

export function WorkspaceOnboarding({ onDone }: { onDone: () => void }) {
  const [suggestion, setSuggestion] = useState('')
  const [path, setPath] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.miki.workspaceStatus().then((st) => {
      setSuggestion(st.defaultSuggestion)
      setPath(st.defaultSuggestion)
    })
  }, [])

  const browse = async () => {
    const p = await window.miki.workspaceChooseFolder()
    if (p) setPath(p)
  }

  const confirm = async () => {
    setBusy(true)
    setError('')
    const r = await window.miki.workspaceConfirm(path.trim())
    setBusy(false)
    if (r.ok) onDone()
    else setError(r.error ?? '无法使用该文件夹')
  }

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <div className="onboarding-logo">miki</div>
        <h2>选择数据文件夹</h2>
        <p className="onboarding-hint">
          你的牌组、卡片与学习记录都存放在这个文件夹里：纯文件、易备份、可用 git 同步。
          位置和名称随意（默认建议 {suggestion || '~/miki-base'}）；多人共用电脑时每人一个文件夹，
          之后可在设置页添加与切换。
        </p>
        <div className="onboarding-row">
          <input value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} />
          <button onClick={() => void browse()}>浏览…</button>
        </div>
        {error && <p className="onboarding-error">{error}</p>}
        <button className="primary" disabled={busy || !path.trim()} onClick={() => void confirm()}>
          {busy ? '正在初始化…' : '开始使用'}
        </button>
      </div>
    </div>
  )
}
