// 移动端壳：M0/M1 阶段是「设备自检」一屏——把不需要凭据的探针跑出来给人看，
// 同时把结果打进 console（Capacitor 转发进 logcat，所以模拟器/真机接上 adb 就能读结果，不用截图）。
// M2 起这里换成牌组页 → 学习页 → 卡片库/统计/设置的真实导航。
import { useEffect, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { CapacitorFileStore } from '@mobile/fs'
import { probeNdjsonPerf, probePrivateStorage, type ProbeResult } from '@mobile/probes'
import { runDeviceSelfCheck } from '@mobile/selfcheck'
import { WORKSPACE_DIR } from '@mobile/constants'

export function App(): JSX.Element {
  const [results, setResults] = useState<ProbeResult[]>([])
  const [running, setRunning] = useState(false)
  const started = useRef(false)

  const native = Capacitor.isNativePlatform()

  async function run(): Promise<void> {
    setRunning(true)
    setResults([])
    const store = new CapacitorFileStore()
    const out = await runDeviceSelfCheck(store, WORKSPACE_DIR, {
      storage: () => probePrivateStorage(store, WORKSPACE_DIR),
      perf: () => probeNdjsonPerf(store, WORKSPACE_DIR)
    })
    setResults(out)
    setRunning(false)
  }

  // 原生壳里自动跑一次：装到设备上 adb 就能直接读到结论，不需要人点按钮
  useEffect(() => {
    if (native && !started.current) {
      started.current = true
      void run()
    }
  }, [native])

  const failed = results.filter((r) => r.status === 'fail').length
  const passed = results.filter((r) => r.status === 'pass').length

  return (
    <div className="app">
      <header className="app-header">
        <h1>Miki</h1>
        <p className="muted">
          {native ? `原生壳：${Capacitor.getPlatform()}` : '浏览器（非原生壳）'} · 工作区：{WORKSPACE_DIR}
        </p>
      </header>

      <main className="app-body">
        <section className="card">
          <h2>设备自检</h2>
          <p className="muted">
            探针只读写合成假数据，且都在 <code>{WORKSPACE_DIR}__selfcheck/</code> 这类独立目录里，
            不碰任何真实学习数据，也不需要任何权限。跑完即删。
          </p>
          {results.length > 0 ? (
            <p className={failed === 0 ? 'ok-line' : 'bad-line'}>
              {results.length} 项：通过 {passed}，失败 {failed}
            </p>
          ) : null}
          <button className="btn primary" onClick={run} disabled={running || !native}>
            {running ? '跑着呢…' : native ? '重新自检' : '请在手机上运行（浏览器里没有原生文件系统）'}
          </button>
        </section>

        {results.map((r, i) => (
          <section key={`${r.id}-${i}`} className="card">
            <h3>
              <span className={`tag ${r.status}`}>
                {r.status === 'pass' ? '通过' : r.status === 'fail' ? '失败' : '跳过'}
              </span>
              {r.title}
            </h3>
            <ul className="detail">
              {r.detail.map((d, idx) => (
                <li key={idx}>{d}</li>
              ))}
            </ul>
            {r.note ? <p className="note">{r.note}</p> : null}
          </section>
        ))}
      </main>
    </div>
  )
}
