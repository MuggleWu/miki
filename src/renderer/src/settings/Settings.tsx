// 设置页：刷卡字体（正面/反面）与 leech 阈值；改动即存 config.json
import { useApp } from '../store'
import type { MikiConfig } from '../../../shared/types'

const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: '系统默认', value: '' },
  { label: '苹方（黑体）', value: "'PingFang SC', 'Microsoft YaHei', sans-serif" },
  { label: '宋体（衬线）', value: "'Songti SC', 'STSong', 'SimSun', serif" },
  { label: '楷体', value: "'Kaiti SC', 'STKaiti', 'KaiTi', serif" },
  { label: '圆体', value: "'Yuanti SC', 'Hiragino Maru Gothic ProN', sans-serif" },
  { label: '等宽', value: "ui-monospace, 'SF Mono', Menlo, monospace" }
]

const SAMPLE = 'The only way out is through.\n示例：FSRS-6 调度，稳定度 S=3.2，难度 D=5.5。'

export function Settings() {
  const config = useApp((s) => s.config)
  const reload = useApp((s) => s.reload)

  if (!config) return null

  const save = async (patch: Partial<MikiConfig>) => {
    await window.miki.saveConfig(patch)
    await reload()
  }

  const font = config.study

  return (
    <div className="settings">
      <section className="settings-card">
        <h3>刷卡字体</h3>
        <p className="settings-hint">
          默认「系统默认」跟随系统字体（macOS：苹方 / SF Pro），与 Obsidian 默认字体一致；
          默认字号 16px 同 Obsidian。作用于学习页的正面与反面内容区。
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
            字号 {font.fontSize}px
            <input
              type="range"
              min={12}
              max={32}
              step={1}
              value={font.fontSize}
              onChange={(e) => void save({ study: { ...font, fontSize: Number(e.target.value) } })}
            />
          </label>
        </div>
        <div
          className="settings-sample"
          style={{ fontFamily: font.fontFamily || undefined, fontSize: font.fontSize }}
        >
          {SAMPLE.split('\n').map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      </section>

      <section className="settings-card">
        <h3>Leech（难卡暂停）</h3>
        <p className="settings-hint">
          一张卡累计「重来」次数达到阈值后自动暂停，不再出现在学习队列与计数中；
          可在卡片库右侧面板解除暂停。设为 0 关闭该功能。
        </p>
        <div className="settings-row">
          <label>
            阈值（次数）
            <input
              className="w-narrow"
              type="number"
              min={0}
              max={999}
              value={config.leechThreshold}
              onChange={(e) => {
                const v = Math.max(0, Math.min(999, Number(e.target.value) || 0))
                void save({ leechThreshold: v })
              }}
            />
          </label>
        </div>
      </section>
    </div>
  )
}
