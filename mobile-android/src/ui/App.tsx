// 应用外壳：boot 工作区与偏好 → 按路由渲染页面 → 接系统返回键 → 维持屏幕常亮。
//
// 自研路由而不是 react-router：页面是个位数，且需要跟 Android 返回键一对一绑定，
// 引一个路由库反而要写更多适配代码。
import { useEffect, useLayoutEffect, useRef } from 'react'
import { App as CapApp } from '@capacitor/app'
import { useApp } from './store'
import { syncToastPopover } from './toast-host'
import { watchKeyboardHeight } from './viewport'
import { DecksPage } from './pages/DecksPage'
import { StudyPage } from './pages/StudyPage'
import { LibraryPage } from './pages/LibraryPage'
import { StatsPage } from './pages/StatsPage'
import { SettingsPage } from './pages/SettingsPage'
import { SelfCheckPage } from './pages/SelfCheckPage'
import { Drawer } from './components/Drawer'
import { ErrorBoundary } from './components/ErrorBoundary'
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

  // 提示条元素：它同时被提升到顶层（popover），见下面那个 layout effect
  const toastRef = useRef<HTMLDivElement>(null)

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

  // 学习页常亮：只在学习页请求，离开就释放——别的页面常亮只是费电。
  //
  // 必须盯着 visibilitychange：文档隐藏时浏览器会**按规范自己释放** Screen Wake Lock，
  // 切出去再回来不会自动恢复（那把锁已经没了，句柄还在，什么都不做就等于没申请）——
  // 表现出来就是"切出去接个电话，回来刷卡时屏幕照常息屏"。
  // 释放句柄放 ref 里：重新获取时要先把上一把释放掉，卸载/离开学习页时也要保证不泄漏。
  const wakeLockRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (route.kind !== 'study' || !prefs.keepAwake) return
    let cancelled = false

    const release = (): void => {
      wakeLockRef.current?.()
      wakeLockRef.current = null
    }
    const acquire = (): void => {
      void acquireWakeLock().then((fn) => {
        // 请求是异步的：在途期间已经离开学习页就别把锁漏在外面
        if (cancelled) fn?.()
        else {
          release() // 重复获取前先放掉旧的
          wakeLockRef.current = fn
        }
      })
    }
    const onVisibility = (): void => {
      // 回到可见且条件仍成立 → 重新获取；隐藏 → 立刻释放（规范也会替我们释放，这里只是不留幻觉句柄）
      if (document.visibilityState === 'visible') acquire()
      else release()
    }

    // 挂载时页面已经是隐藏状态就别申请了：浏览器会直接拒，等可见时那次再拿
    if (document.visibilityState === 'visible') acquire()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      release()
    }
  }, [route.kind, prefs.keepAwake])

  // Android 返回键 → 关弹层 → 路由后退；已经在首页且无栈时交还给系统（= 退出应用）
  useEffect(() => {
    let handle: { remove(): Promise<void> } | undefined
    void CapApp.addListener('backButton', () => {
      const { route: cur, stack, closeTopSheet } = useApp.getState()
      // 弹层/抽屉开着时先关它。原生返回键不会触发 <dialog> 的 cancel，不这样处理的话
      // 用户在编辑卡片时按返回会直接把整个学习页退掉，输入的进度也一起没了。
      if (closeTopSheet()) return
      if (stack.length > 0 || cur.kind !== 'decks') back()
      else void CapApp.exitApp()
    }).then((h) => {
      handle = h
    })
    return () => {
      void handle?.remove()
    }
  }, [back])

  // 键盘占位：把"被键盘遮住的高度"写进 CSS 变量 --kb，弹层底部据此留白（见 styles.css）。
  //
  // 为什么不能只靠 manifest 的 adjustResize：Android 15+ 的边到边布局下，窗口不再随输入法
  // 收缩，adjustResize 对 WebView 等于失效——键盘盖在内容上，聚焦的输入框也不会被滚出来。
  // 所以这里补两层：网页侧按可视视口算 --kb（滚动留白、弹层让位），原生侧按输入法内边距把
  // WebView 顶上去（MainActivity，那才是"能不能看见正在打的字"的关键）。
  // 两套不会叠加：原生把视口顶上去之后，vv.height 跟着变小，这里算出来就接近 0。
  useEffect(
    () =>
      watchKeyboardHeight({
        onChange: (kb) => document.documentElement.style.setProperty('--kb', `${kb}px`),
        log: true
      }),
    []
  )

  // 回到前台自动拉取（设计文档：拉取是只读的、静默的；推送只由用户点触发）
  // 注意这里必须是 'pull-only'：推送只发生在用户点"推送进度 / 立即同步"时
  useEffect(() => {
    let handle: { remove(): Promise<void> } | undefined
    void CapApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) return
      const st = useApp.getState()
      // 还没配同步、正在同步、或工作区还没起来都不重复拉
      if (!st.ws || st.sync.busy || !st.sync.status?.configured) return
      void st.syncNow('pull-only')
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

  // 提示条要显示在弹层之上：原生 <dialog>.showModal() 会把对话框提到顶层，挂在 .app 下的
  // 提示条会被它和遮罩盖住——弹层开着时（比如连续新增卡片）用户等于是完全看不到提示。
  // 用 popover API 把提示条也提进顶层（不移 DOM，理由见 toast-host.ts）。
  //
  // 依赖里带 toast：提示出现时它可能还没进顶层，出现后再同步一次。
  useLayoutEffect(() => {
    syncToastPopover(toastRef.current, toast !== null)
  }, [toast])

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
      {/* 每个页面各自一个边界：一页渲染炸了不影响切页（抽屉与提示条都在边界外），
          用户能换到别的页继续用——自检页尤其要在，它正是排查这类问题的入口。
          label 按页面区分，用户描述问题时报的是哪一页。 */}
      {route.kind === 'decks' ? (
        <ErrorBoundary label="牌组页出错了">
          <DecksPage />
        </ErrorBoundary>
      ) : null}
      {/* key 绑定 deckId：换牌组就重挂载学习页，会话状态自然重置，不需要在 effect 里纠正 */}
      {route.kind === 'study' ? (
        <ErrorBoundary label="学习页出错了">
          <StudyPage key={route.deckId} deckId={route.deckId} />
        </ErrorBoundary>
      ) : null}
      {route.kind === 'library' ? (
        <ErrorBoundary label="卡片库出错了">
          <LibraryPage />
        </ErrorBoundary>
      ) : null}
      {route.kind === 'stats' ? (
        <ErrorBoundary label="统计页出错了">
          <StatsPage />
        </ErrorBoundary>
      ) : null}
      {route.kind === 'settings' ? (
        <ErrorBoundary label="设置页出错了">
          <SettingsPage />
        </ErrorBoundary>
      ) : null}
      {route.kind === 'selfcheck' ? (
        <ErrorBoundary label="设备自检出错了">
          <SelfCheckPage />
        </ErrorBoundary>
      ) : null}
      {/* 关闭一律走 closeDrawer：它会先播放收起动画再改 open，点遮罩/返回键/选中条目都一致 */}
      <Drawer open={drawerOpen} onClose={closeDrawer} />
      {/*
        提示条：popover="manual" 让它能进顶层、盖在弹层之上（弹层开着时提示才看得见）。
        属性走展开而不是直接写 popover="manual"：本工程用的 @types/react 还没有 popover
        的声明（React 18 时代），直接写会被 TS 判成"DOM 上不存在这个属性"——而浏览器认它。
        升级到 React 19 类型后可改回直写，这一点不可靠就退回普通 fixed 元素（视觉降级）。
      */}
      <div ref={toastRef} className="toast" {...{ popover: 'manual' }} aria-live="polite">
        {toast}
      </div>
    </div>
  )
}
