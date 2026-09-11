// 应用外壳：boot 工作区与偏好 → 按路由渲染页面 → 接系统返回键 → 维持屏幕常亮。
//
// 自研路由而不是 react-router：页面是个位数，且需要跟 Android 返回键一对一绑定，
// 引一个路由库反而要写更多适配代码。
import { useEffect } from 'react'
import { App as CapApp } from '@capacitor/app'
import { useApp } from './store'
import { DecksPage } from './pages/DecksPage'
import { StudyPage } from './pages/StudyPage'
import { LibraryPage } from './pages/LibraryPage'
import { StatsPage } from './pages/StatsPage'
import { SettingsPage } from './pages/SettingsPage'
import { SelfCheckPage } from './pages/SelfCheckPage'
import { Drawer } from './components/Drawer'
import { useEdgeSwipeDrawer } from './use-edge-swipe'
import { applyAppearance, acquireWakeLock, watchSystemDark } from '@mobile/theme'

export function App(): JSX.Element {
  const ws = useApp((s) => s.ws)
  const bootError = useApp((s) => s.bootError)
  const route = useApp((s) => s.route)
  const toast = useApp((s) => s.toast)
  const prefs = useApp((s) => s.prefs)
  const notify = useApp((s) => s.notify)
  const back = useApp((s) => s.back)
  const boot = useApp((s) => s.boot)
  const loadPrefs = useApp((s) => s.loadPrefs)
  const drawerOpen = useApp((s) => s.drawerOpen)
  const closeDrawer = useApp((s) => s.closeDrawer)

  useEffect(() => {
    void boot()
    void loadPrefs()
  }, [boot, loadPrefs])

  // 左边缘右滑唤出抽屉：抽屉本身挂在全局，所以任何非学习页都能滑出来
  useEdgeSwipeDrawer()

  // 主题与字号：写到 <html> 上，CSS 只认 data-theme 与 --fs-scale 两个入口
  useEffect(() => {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    applyAppearance(prefs.theme, prefs.fontScale, dark)
    // 「跟随系统」要在系统切换时跟着变——只在启动时读一次 matchMedia 是不够的
    if (prefs.theme !== 'system') return
    return watchSystemDark((nowDark) => applyAppearance('system', prefs.fontScale, nowDark))
  }, [prefs.theme, prefs.fontScale])

  // 学习页常亮：只在学习页请求，离开就释放——别的页面常亮只是费电
  useEffect(() => {
    if (route.kind !== 'study' || !prefs.keepAwake) return
    let release: (() => void) | null = null
    let cancelled = false
    void acquireWakeLock().then((fn) => {
      // 请求是异步的：在途期间已经离开学习页就立刻释放，别把锁漏掉
      if (cancelled) fn?.()
      else release = fn
    })
    return () => {
      cancelled = true
      release?.()
    }
  }, [route.kind, prefs.keepAwake])

  // Android 返回键 → 路由后退；已经在首页且无栈时交还给系统（= 退出应用）
  useEffect(() => {
    let handle: { remove(): Promise<void> } | undefined
    void CapApp.addListener('backButton', () => {
      const { route: cur, stack } = useApp.getState()
      if (stack.length > 0 || cur.kind !== 'decks') back()
      else void CapApp.exitApp()
    }).then((h) => {
      handle = h
    })
    return () => {
      void handle?.remove()
    }
  }, [back])

  // 键盘占位：把"被键盘遮住的高度"写进 CSS 变量，弹层底部据此留白。
  //
  // 为什么不能只靠 manifest 的 adjustResize：Android 11+ 的边到边布局下，
  // WebView 的视口不一定随键盘收缩（真机上就看到过——编辑卡片时保存按钮被键盘盖住）。
  // VisualViewport 是 WebView 自己能观测到的事实，不依赖系统那套窗口 inset 的行为差异。
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const apply = (): void => {
      // 键盘高度 = 布局视口高度 − 可见视口高度。
      // 关键点：**不能用 window.innerHeight**——它在 Chrome/WebView 上跟着视觉视口一起缩
      // （实测键盘弹起时 842→530，算出来永远是 0），而 fixed 定位参照的布局视口不缩，
      // 于是弹层比可见区域还高、底部按钮永远在屏幕外。documentElement.clientHeight 才是布局视口。
      const layoutH = document.documentElement.clientHeight
      const kb = Math.max(0, layoutH - vv.height - vv.offsetTop)
      document.documentElement.style.setProperty('--kb', `${Math.round(kb)}px`)
      // 键盘高度的实测值：只有这里能看清"WebView 到底有没有跟着键盘收缩"，
      // 排这类问题时不用盲改 CSS（innerHeight 与 vv.height 同步变小就是收缩了）
      console.log(
        `[miki-kb] layout=${layoutH} inner=${window.innerHeight} vv=${Math.round(vv.height)} kb=${Math.round(kb)}`
      )
    }
    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
    }
  }, [])

  // 回到前台自动拉取（设计文档：拉取是只读的、静默的；推送只由用户点触发）
  useEffect(() => {
    let handle: { remove(): Promise<void> } | undefined
    void CapApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) return
      const st = useApp.getState()
      // 还没配同步、正在同步、或工作区还没起来都不重复拉
      if (!st.ws || st.sync.busy || !st.sync.status?.configured) return
      void st.syncNow(false)
    }).then((h) => {
      handle = h
    })
    return () => {
      void handle?.remove()
    }
  }, [])

  // 提示条 2.5 秒后自动消失
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => notify(null), 2500)
    return () => clearTimeout(t)
  }, [toast, notify])

  if (bootError) {
    return (
      <div className="app">
        <div className="page-body">
          <section className="card">
            <h2>工作区打不开</h2>
            <p className="note">{bootError}</p>
            <p className="muted">这通常意味着应用私有目录不可用（换设备/刷机后才该出现）。设备自检页能给出更多线索。</p>
          </section>
        </div>
      </div>
    )
  }

  if (!ws) {
    return (
      <div className="app">
        <div className="page-body">
          <p className="muted">正在打开工作区…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      {/* key 绑定 deckId：换牌组就重挂载学习页，会话状态自然重置，不需要在 effect 里纠正 */}
      {route.kind === 'decks' ? <DecksPage /> : null}
      {route.kind === 'study' ? <StudyPage key={route.deckId} deckId={route.deckId} /> : null}
      {route.kind === 'library' ? <LibraryPage /> : null}
      {route.kind === 'stats' ? <StatsPage /> : null}
      {route.kind === 'settings' ? <SettingsPage /> : null}
      {route.kind === 'selfcheck' ? <SelfCheckPage /> : null}
      {/* 关闭一律走 closeDrawer：它会先播放收起动画再改 open，点遮罩/返回键/选中条目都一致 */}
      <Drawer open={drawerOpen} onClose={closeDrawer} />
      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  )
}
