// 应用外壳：boot 工作区 → 按路由渲染页面 → 接系统返回键。
//
// 自研路由而不是 react-router：页面是个位数，且需要跟 Android 返回键一对一绑定，
// 引一个路由库反而要写更多适配代码。
import { useEffect } from 'react'
import { App as CapApp } from '@capacitor/app'
import { useApp } from './store'
import { DecksPage } from './pages/DecksPage'
import { StudyPage } from './pages/StudyPage'
import { SelfCheckPage } from './pages/SelfCheckPage'

export function App(): JSX.Element {
  const ws = useApp((s) => s.ws)
  const bootError = useApp((s) => s.bootError)
  const route = useApp((s) => s.route)
  const toast = useApp((s) => s.toast)
  const notify = useApp((s) => s.notify)
  const back = useApp((s) => s.back)
  const boot = useApp((s) => s.boot)

  useEffect(() => {
    void boot()
  }, [boot])

  // Android 返回键 → 路由后退；已经在首页时交还给系统（= 退出应用）
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
      {route.kind === 'decks' ? <DecksPage /> : null}
      {/* key 绑定 deckId：换牌组就重挂载学习页，会话状态自然重置，不需要在 effect 里纠正 */}
      {route.kind === 'study' ? <StudyPage key={route.deckId} deckId={route.deckId} /> : null}
      {route.kind === 'selfcheck' ? <SelfCheckPage /> : null}
      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  )
}
