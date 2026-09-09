// 设置页：工作区（多用户档案）、刷卡字体（正面/反面）与 leech 阈值；改动即存 config.json
import { useEffect, useRef, useState } from 'react'
import { useApp } from '../store'
import type { MikiConfig } from '../../../shared/types'
import type { WorkspaceStatus } from '../../../shared/workspace'

const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: '系统默认', value: '' },
  { label: '苹方（黑体）', value: "'PingFang SC', 'Microsoft YaHei', sans-serif" },
  { label: '宋体（衬线）', value: "'Songti SC', 'STSong', 'SimSun', serif" },
  { label: '楷体', value: "'Kaiti SC', 'STKaiti', 'KaiTi', serif" },
  { label: '圆体', value: "'Yuanti SC', 'Hiragino Maru Gothic ProN', sans-serif" },
  { label: '等宽', value: "ui-monospace, 'SF Mono', Menlo, monospace" }
]

const SAMPLE = 'The only way out is through.\n示例：FSRS-6 调度，稳定度 S=3.2，难度 D=5.5。'

/** 工作区（多用户档案）卡片：当前档案 + 已记住列表的切换/增删；切换写指针后应用自动重启 */
function WorkspaceCard() {
  const [st, setSt] = useState<WorkspaceStatus | null>(null)
  const [error, setError] = useState('')
  const refresh = () => void window.miki.workspaceStatus().then(setSt)
  useEffect(refresh, [])

  const run = async (fn: () => Promise<unknown>) => {
    setError('')
    await fn()
    refresh()
  }

  if (!st) return null
  return (
    <section className="settings-card">
      <h3>工作区（用户档案）</h3>
      <p className="settings-hint">
        每个工作区文件夹 = 一份完整档案（牌组、卡片、学习记录与配置各自独立）。
        切换后应用自动重启载入对应档案；移除只从列表去掉，不删除文件夹内的任何数据。
      </p>
      <ul className="ws-list">
        {st.workspaces.map((w) => {
          const current = w.path === st.current
          return (
            <li key={w.path} className={current ? 'ws-current' : ''}>
              <span className="ws-list-name" title={w.path}>
                {w.name}
                {current && <em>当前</em>}
              </span>
              <span className="ws-list-actions">
                {!current && <button onClick={() => void run(() => window.miki.workspaceSwitch(w.path))}>切换</button>}
                {current && <button onClick={() => void window.miki.workspaceReveal(w.path)}>打开文件夹</button>}
                {!current && (
                  <button className="danger" onClick={() => void run(() => window.miki.workspaceRemove(w.path))}>
                    移除
                  </button>
                )}
              </span>
            </li>
          )
        })}
      </ul>
      {error && <p className="onboarding-error">{error}</p>}
      <div className="settings-row">
        <button
          onClick={() =>
            void run(async () => {
              const p = await window.miki.workspaceChooseFolder()
              if (!p) return
              const r = await window.miki.workspaceAdd(p)
              if (!r.ok) setError(r.error ?? '无法使用该文件夹')
            })
          }
        >
          添加工作区…
        </button>
      </div>
    </section>
  )
}

/** 数值草稿：滑块拖动/连续输入过程只改本地草稿，停顿 delay 毫秒、失焦或卸载才落盘一次。
 * 落盘后 reload 回读的「回声」（等于上次发送值）不回写草稿，避免拖动中被旧值拉回。 */
function useNumericDraft(configValue: number, commit: (v: number) => void, delay = 400) {
  const [draft, setDraft] = useState(configValue)
  const draftRef = useRef(configValue)
  const sentRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const commitRef = useRef(commit)
  commitRef.current = commit

  // 外部配置变化同步草稿；自家落盘的回声一次性消费，不回写
  useEffect(() => {
    const isEcho = sentRef.current !== null && configValue === sentRef.current
    sentRef.current = null
    if (isEcho) return
    draftRef.current = configValue
    setDraft(configValue)
  }, [configValue])

  const set = (v: number) => {
    draftRef.current = v
    setDraft(v)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      sentRef.current = draftRef.current
      commitRef.current(draftRef.current)
    }, delay)
  }

  // 松手/失焦立即落盘，不等防抖计时
  const flush = () => {
    if (!timerRef.current) return
    clearTimeout(timerRef.current)
    timerRef.current = null
    sentRef.current = draftRef.current
    commitRef.current(draftRef.current)
  }

  // 带着未落盘的草稿离开设置页：补一次落盘
  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        commitRef.current(draftRef.current)
      }
    },
    []
  )

  return { draft, set, flush }
}

export function Settings() {
  const config = useApp((s) => s.config)
  const reload = useApp((s) => s.reload)

  // 滑块/数字输入先写草稿再落盘：拖动过程不产生每格一次的 config.json 写入
  const fontSize = useNumericDraft(config?.study.fontSize ?? 16, (v) => {
    void window.miki.saveConfig({ study: { fontSize: v } }).then(reload)
  })
  const leech = useNumericDraft(config?.leechThreshold ?? 8, (v) => {
    void window.miki.saveConfig({ leechThreshold: v }).then(reload)
  })

  if (!config) return null

  const save = async (patch: Partial<MikiConfig>) => {
    await window.miki.saveConfig(patch)
    await reload()
  }

  const font = config.study

  return (
    <div className="settings">
      <WorkspaceCard />
      <section className="settings-card">
        <h3>刷卡字体</h3>
        <p className="settings-hint">
          默认「系统默认」跟随系统字体（macOS：苹方 / SF Pro），与 Obsidian 默认字体一致； 默认字号 16px 同
          Obsidian。作用于学习页的正面与反面内容区。
        </p>
        <div className="settings-row">
          <label>
            字体
            <select
              value={font.fontFamily}
              onChange={(e) => void save({ study: { ...font, fontFamily: e.target.value } })}
            >
              {FONT_OPTIONS.map((o) => (
                <option key={o.label} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            字号 {fontSize.draft}px
            <input
              type="range"
              min={12}
              max={32}
              step={1}
              value={fontSize.draft}
              onChange={(e) => fontSize.set(Number(e.target.value))}
              onPointerUp={fontSize.flush}
              onBlur={fontSize.flush}
            />
          </label>
        </div>
        <div className="settings-sample" style={{ fontFamily: font.fontFamily || undefined, fontSize: fontSize.draft }}>
          {SAMPLE.split('\n').map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      </section>

      <section className="settings-card">
        <h3>Leech（难卡暂停）</h3>
        <p className="settings-hint">
          一张卡累计「重来」次数达到阈值后自动暂停，不再出现在学习队列与计数中； 可在卡片库右侧面板解除暂停。设为 0
          关闭该功能。
        </p>
        <div className="settings-row">
          <label>
            阈值（次数）
            <input
              className="w-narrow"
              type="number"
              min={0}
              max={999}
              value={leech.draft}
              onChange={(e) => {
                const n = Math.floor(Number(e.target.value) || 0)
                leech.set(Math.max(0, Math.min(999, n)))
              }}
              onBlur={leech.flush}
            />
          </label>
        </div>
      </section>
    </div>
  )
}
