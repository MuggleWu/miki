// 设备自检页：M0 阶段的那一屏（探针 1/2/5）。
// 放在应用里而不是只做一次性脚本：换手机、升 Android 版本、换 Capacitor 版本时，
// 「私有目录还能不能写、追加还是不是追加」这些前提都可能变，随时能自己跑一遍比看文档靠谱。
import { useEffect, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { useApp } from '../store'
import { CapacitorFileStore } from '@mobile/fs'
import { MobilePaths } from '@mobile/paths'
import { probeNdjsonPerf, probePrivateStorage, type ProbeResult } from '@mobile/probes'
import { runDeviceSelfCheck } from '@mobile/selfcheck'
import { WORKSPACE_DIR } from '@mobile/constants'

export function SelfCheckPage(): JSX.Element {
  const back = useApp((s) => s.back)
  const [results, setResults] = useState<ProbeResult[]>([])
  const [running, setRunning] = useState(false)
  const started = useRef(false)
  const native = Capacitor.isNativePlatform()

  async function run(): Promise<void> {
    setRunning(true)
    setResults([])
    const store = new CapacitorFileStore()
    setResults(
      await runDeviceSelfCheck(store, WORKSPACE_DIR, {
        storage: () => probePrivateStorage(store, WORKSPACE_DIR),
        perf: () => probeNdjsonPerf(store, WORKSPACE_DIR)
      })
    )
    setRunning(false)
  }

  useEffect(() => {
    if (native && !started.current) {
      started.current = true
      void run()
    }
  }, [native])

  const failed = results.filter((r) => r.status === 'fail').length
  const passed = results.filter((r) => r.status === 'pass').length

  return (
    <>
      <div className="page-head">
        <button className="icon-btn" onClick={back} aria-label="返回">
          ‹
        </button>
        <h1>设备自检</h1>
      </div>

      <div className="page-body">
        <section className="card">
          <p className="muted">
            探针只读写合成假数据，且都在 <code>{WORKSPACE_DIR}__selfcheck/</code> 这类独立目录里，
            不碰任何真实学习数据，也不需要任何权限；跑完即删。工作区实际路径：
          </p>
          <p className="mono">{new MobilePaths(WORKSPACE_DIR).root}</p>
          {results.length > 0 ? (
            <p className={failed === 0 ? 'ok-line' : 'bad-line'}>
              {results.length} 项：通过 {passed}，失败 {failed}
            </p>
          ) : null}
          <button className="btn primary" onClick={() => void run()} disabled={running || !native}>
            {running ? '跑着呢…' : native ? '重新自检' : '浏览器里没有原生文件系统'}
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
      </div>
    </>
  )
}
