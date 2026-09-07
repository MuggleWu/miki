// App：tab 路由 + 全局快捷键（A/B/T/S/D，NF3 输入互斥）+ 主题（浅色默认）
import { useEffect } from 'react'
import { isTypingTarget, useApp } from './store'
import { Home } from './home/Home'
import { Study } from './study/Study'
import { Browser } from './browser/Browser'
import { Stats } from './stats/Stats'
import { Settings } from './settings/Settings'
import { AddEditDialog } from './components/AddEditDialog'

export default function App() {
  const tab = useApp((s) => s.tab)
  const decks = useApp((s) => s.decks)
  const config = useApp((s) => s.config)
  const reload = useApp((s) => s.reload)
  const setTab = useApp((s) => s.setTab)
  const openBrowser = useApp((s) => s.openBrowser)
  const openDialog = useApp((s) => s.openDialog)

  // 启动与每次切视图都重取全局数据（牌组计数 / 今天已学）：
  // 学习页 ⌘D 删除、答题等操作只刷新本视图，不主动刷牌组列表——靠切视图即时刷新，不必等 60s 定时器
  useEffect(() => {
    void reload()
  }, [tab, reload])

  // 60 秒重取全局数据（牌组计数 / 今天已学），随时间推移保持各视图最新
  useEffect(() => {
    const t = setInterval(() => void reload(), 60_000)
    return () => clearInterval(t)
  }, [reload])

  // 主进程热加载完成（git pull / 他机写入等外部变更）→ 重取全局数据 + 让当前视图就地刷新
  useEffect(() => {
    const off = window.miki.onWorkspaceChanged(() => {
      void reload()
      useApp.getState().bumpData()
    })
    return off
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
      if (key === 'escape') {
        if (s.dialog) s.closeDialog()
        return
      }
      // 弹窗打开时屏蔽单字母快捷键，避免穿透操作背后的界面
      if (s.dialog) return
      if (key === 'a') {
        e.preventDefault()
        const deckId = s.studyDeckId ?? s.selectedDeckId ?? s.decks[0]?.id ?? null
        openDialog({ mode: 'add', deckId, cardId: null })
      } else if (key === 'b') {
        e.preventDefault()
        if (s.tab === 'study' && s.studyDeckId) {
          openBrowser(s.studyDeckId, s.studyCurrentCardId)
        } else {
          openBrowser() // 缺省：保留上次选中的牌组
        }
      } else if (key === 't') {
        e.preventDefault()
        setTab('stats')
      } else if (key === 's' && s.tab === 'home') {
        // 首页：S 进入默认牌组（当前选中，否则第一个）
        e.preventDefault()
        const deckId = s.selectedDeckId ?? s.decks[0]?.id
        if (deckId) s.enterStudy(deckId)
      } else if (key === 'd') {
        // 任意位置：D 回到首页
        e.preventDefault()
        setTab('home')
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
        <button className={`tab ${tab === 'browser' ? 'active' : ''}`} onClick={() => openBrowser()}>
          卡片库
        </button>
        <button className={`tab ${tab === 'stats' ? 'active' : ''}`} onClick={() => setTab('stats')}>
          统计
        </button>
        <button className={`tab ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
          设置
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
        {tab === 'settings' && <Settings />}
      </div>

      <AddEditDialog />
    </div>
  )
}
