// App：tab 路由 + 全局快捷键（A/B/T/S/D，NF3 输入互斥）+ 主题（浅色默认）
// 卡片添加/编辑为独立弹窗子窗口（main 进程管理）：这里只负责请求开/关 + 同步开关状态 + 数据刷新
import { useEffect, useState } from 'react'
import { isTypingTarget, useApp } from './store'
import { workspaceName, type DamageReport } from '../../shared/workspace'
import { ErrorBoundary } from './components/ErrorBoundary'
import { WorkspaceOnboarding } from './WorkspaceOnboarding'
import { Home } from './home/Home'
import { Study } from './study/Study'
import { Browser } from './browser/Browser'
import { Stats } from './stats/Stats'
import { Settings } from './settings/Settings'

/** 首次启动引导：无有效工作区指针时引导页接管主窗口，确认后进入主界面 */
export default function App() {
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean | null>(null)
  useEffect(() => {
    void window.miki.workspaceStatus().then((st) => setNeedsOnboarding(st.needsOnboarding))
  }, [])
  if (needsOnboarding === null) return null
  if (needsOnboarding) return <WorkspaceOnboarding onDone={() => setNeedsOnboarding(false)} />
  return <MainApp />
}

function MainApp() {
  const tab = useApp((s) => s.tab)
  const decks = useApp((s) => s.decks)
  const config = useApp((s) => s.config)
  const reload = useApp((s) => s.reload)
  const setTab = useApp((s) => s.setTab)
  const openBrowser = useApp((s) => s.openBrowser)
  const openDialog = useApp((s) => s.openDialog)
  // 加载期数据损坏提示：坏行会被静默跳过（内容与统计悄悄少算），给用户一个可见出口。
  // 只在启动查一次；用户关掉后本会话不再出现（热加载会重新结算，但循环弹出比漏报更烦人）
  const [damage, setDamage] = useState<DamageReport | null>(null)
  /** 热加载作废撤销栈的步数（null = 无提示） */
  const [undoLost, setUndoLost] = useState<number | null>(null)

  useEffect(() => {
    void window.miki
      .dataDamageReport()
      .then(setDamage)
      .catch(() => setDamage(null))
  }, [])

  // 窗口标题携带当前工作区名（Miki - 工作区名），多工作区时便于区分窗口；
  // 引导页（config 未就绪）或工作区路径缺失时保持默认 Miki。
  // workspaceName 会对入参调 split——workspacePath 缺失时不给它 undefined，否则这个
  // 纯展示用的 effect 抛出未捕获异常会打掉整个首屏。
  useEffect(() => {
    const p = config?.workspacePath
    document.title = typeof p === 'string' && p ? `Miki - ${workspaceName(p)}` : 'Miki'
  }, [config])

  // 卡片弹窗子窗口状态同步：主窗口 store.dialog 只是标志镜像（快捷键屏蔽 + Esc 判断）。
  // 开窗时调用方已先经 store.openDialog 记状态，这里只处理「窗口侧关闭」（弹窗内 Esc/⌘W/提交完成）
  useEffect(() => {
    const off = window.miki.onCardDialogVisibility((visible) => {
      if (!visible) useApp.setState({ dialog: null })
    })
    return off
  }, [])

  // 弹窗子窗口提交卡片后（add/edit）：刷新全局数据 + 当前视图数据。
  // bumpData 驱动学习页/卡片库/统计页重取；reload 刷牌组计数与首页数字
  useEffect(() => {
    const off = window.miki.onCardsChanged(() => {
      void reload()
      useApp.getState().bumpData()
    })
    return off
  }, [reload])

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

  // 热加载作废了本会话撤销栈：静默作废在键盘上表现为「⌘Z 没反应」，这里显式提示一次
  useEffect(() => {
    return window.miki.onUndoDiscarded((dropped) => setUndoLost(dropped))
  }, [])

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
        if (s.dialog) s.closeDialog() // 关的是独立子窗口（store 桥接 IPC，主窗口 DOM 已无弹窗层）
        return
      }
      // A 在弹窗屏蔽之前放行：卡片弹窗子窗口已开时按 A 同样唤起它——主进程对已存在的弹窗窗口
      // 重发载荷并 show+focus（已开新增弹窗→原样置前；开的是编辑弹窗→切到新增表单），
      // 与学习页 E 唤起编辑弹窗（Study 自己的监听，不受弹窗屏蔽）对等
      if (key === 'a') {
        e.preventDefault()
        const deckId = s.studyDeckId ?? s.selectedDeckId ?? s.decks[0]?.id ?? null
        // 请求主进程开卡片弹窗子窗口（store.openDialog 桥接 IPC 并记状态）
        openDialog({ mode: 'add', deckId, cardId: null })
        return
      }
      // 弹窗打开时屏蔽其余单字母快捷键，避免穿透操作背后的界面
      if (s.dialog) return
      if (key === 'b') {
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
          <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>工作区为空：先创建一个牌组</span>
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
        {damage &&
          (damage.damagedLines > 0 || damage.truncatedFiles.length > 0 || (damage.corruptDocs?.length ?? 0) > 0) && (
            <div className="damage-banner">
              <span>
                检测到数据异常：
                {(damage.corruptDocs?.length ?? 0) > 0 &&
                  `${damage.corruptDocs.join('、')} 读不出来（JSON 文档损坏或写入被中断）——` +
                    '牌组表读不出来时卡片会全部变成孤儿，先在桌面端修好这份文件再同步；'}
                {damage.damagedLines > 0 && `${damage.damagedLines} 行无法解析（这些行的效果已丢失）`}
                {damage.damagedLines > 0 && damage.truncatedFiles.length > 0 && '；'}
                {damage.truncatedFiles.length > 0 &&
                  `${damage.truncatedFiles.length} 个文件末尾不完整（多半是异常退出时写入被中断）`}
                {damage.files.length > 0 && `。涉及：${damage.files.join('、')}`}
              </span>
              <button className="damage-dismiss" onClick={() => setDamage(null)} title="关闭提示（数据不会因此恢复）">
                知道了
              </button>
            </div>
          )}
        {undoLost !== null && (
          <div className="damage-banner">
            <span>
              撤销历史已清空（之前 {undoLost} 步操作无法再撤销）。工作区被外部修改（git pull / 他机写入 /
              直接编辑文件）后，旧的撤销目标可能已失效，所以作废了本会话的撤销栈。复习数据本身没有受影响。
            </span>
            <button className="damage-dismiss" onClick={() => setUndoLost(null)} title="关闭提示">
              知道了
            </button>
          </div>
        )}
        <div className="page">
          {/* 每个页面各自一个边界：一个页面崩了不影响顶部导航与切换，用户能直接换页继续用 */}
          {tab === 'home' && (
            <ErrorBoundary label="牌组页出错了">
              <Home />
            </ErrorBoundary>
          )}
          {tab === 'study' && (
            <ErrorBoundary label="学习页出错了">
              <Study />
            </ErrorBoundary>
          )}
          {tab === 'browser' && (
            <ErrorBoundary label="卡片库出错了">
              <Browser />
            </ErrorBoundary>
          )}
          {tab === 'stats' && (
            <ErrorBoundary label="统计页出错了">
              <Stats />
            </ErrorBoundary>
          )}
          {tab === 'settings' && (
            <ErrorBoundary label="设置页出错了">
              <Settings />
            </ErrorBoundary>
          )}
        </div>
      </div>
    </div>
  )
}
