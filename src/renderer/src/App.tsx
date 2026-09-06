// App：tab 路由 + 全局快捷键（A/B/T，NF3 输入互斥）+ 主题（浅色默认）
import { useEffect } from 'react'
import { isTypingTarget, useApp } from './store'
import { Home } from './home/Home'
import { Study } from './study/Study'
import { Browser } from './browser/Browser'
import { Stats } from './stats/Stats'
import { AddEditDialog } from './components/AddEditDialog'

export default function App() {
  const tab = useApp((s) => s.tab)
  const decks = useApp((s) => s.decks)
  const config = useApp((s) => s.config)
  const reload = useApp((s) => s.reload)
  const setTab = useApp((s) => s.setTab)
  const openBrowser = useApp((s) => s.openBrowser)
  const openDialog = useApp((s) => s.openDialog)

  useEffect(() => {
    void reload()
  }, [reload])

  // 主题：浅色默认（用户习惯），深色经 data-theme 覆盖
  useEffect(() => {
    document.documentElement.dataset.theme = config?.theme === 'dark' ? 'dark' : 'light'
  }, [config?.theme])

  const toggleTheme = async () => {
    const next = config?.theme === 'dark' ? 'light' : 'dark'
    await window.miki.saveTheme(next)
    await reload()
  }

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) return
      if (isTypingTarget(e.target)) return
      const key = e.key.toLowerCase()
      const s = useApp.getState()
      if (key === 'a') {
        e.preventDefault()
        const deckId = s.studyDeckId ?? s.selectedDeckId ?? s.decks[0]?.id ?? null
        openDialog({ mode: 'add', deckId, cardId: null })
      } else if (key === 'b') {
        e.preventDefault()
        if (s.tab === 'study' && s.studyDeckId) {
          openBrowser(s.studyDeckId, s.studyCurrentCardId)
        } else {
          openBrowser(null)
        }
      } else if (key === 't') {
        e.preventDefault()
        setTab('stats')
      } else if (key === 'escape' && s.dialog) {
        s.closeDialog()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [openBrowser, openDialog, setTab])

  return (
    <div className="app">
      <div className="topbar">
        <span className="logo">miki</span>
        <button className={`tab ${tab === 'home' ? 'active' : ''}`} onClick={() => setTab('home')}>
          牌组
        </button>
        <button className={`tab ${tab === 'browser' ? 'active' : ''}`} onClick={() => openBrowser(null)}>
          卡片库
        </button>
        <button className={`tab ${tab === 'stats' ? 'active' : ''}`} onClick={() => setTab('stats')}>
          统计
        </button>
        {decks.length === 0 && (
          <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
            工作区为空：先创建一个牌组
          </span>
        )}
        <button
          className="theme-btn"
          onClick={() => void toggleTheme()}
          title={config?.theme === 'dark' ? '切换到浅色' : '切换到深色'}
        >
          {config?.theme === 'dark' ? '🌙' : '☀️'}
        </button>
      </div>

      <div className="content">
        {tab === 'home' && <Home />}
        {tab === 'study' && <Study />}
        {tab === 'browser' && <Browser />}
        {tab === 'stats' && <Stats />}
      </div>

      <AddEditDialog />
    </div>
  )
}
