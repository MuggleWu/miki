// 启动首屏：用上一次退出时留下的牌组快照先画出首页。
//
// 只负责"画得像"：结构、类名、顺序与 DecksPage 一致，真页面挂上来时不会跳一下。
// 这期间点不了东西（工作区还没就绪，点了也没法导航），按钮只作为占位保持布局稳定。
import { sumDeckCounts } from '@mobile/workspace'
import type { DeckSnapshot } from '../deck-snapshot'
import type { DeckInfo } from '@shared/types'

export function DeckListPreview({ snap }: { snap: DeckSnapshot }): JSX.Element {
  // 复用首页同一套加和口径：快照行先摆成 DeckInfo 的最小形状，避免这里再写一遍循环
  const decks = snap.decks.map(
    (d) => ({ id: d.id, name: d.name, counts: { total: d.total, new: d.new, due: d.due } }) as DeckInfo
  )
  const totals = sumDeckCounts(decks)

  // 整块禁用指针（.deck-preview）：工作区没就绪时点进去只会是一个坏掉的页面，
  // 但按钮不写 disabled —— 那会触发 :disabled 的变淡样式，快照与真页面之间就会闪一下。
  return (
    <div className="deck-preview">
      <div className="page-head">
        <button className="icon-btn" aria-label="菜单">
          ☰
        </button>
        <h1>牌组</h1>
        <button className="head-btn">推送进度</button>
        <span className="head-note">今日已学 {snap.today} 次</span>
      </div>

      <div className="page-body with-fab">
        <div className="deck-total" aria-label="全部牌组总计">
          <span className="deck-total-name">总计</span>
          <span className="deck-counts">
            <span className="count count-total">{totals.total}</span>
            <span className="count count-new">{totals.new}</span>
            <span className="count count-due">{totals.due}</span>
          </span>
        </div>
        <ul className="deck-list">
          {decks.map((d) => (
            <li key={d.id}>
              <button className="deck-row" aria-disabled="true">
                <span className="deck-name">{d.name}</span>
                <span className="deck-counts">
                  <span className="count count-total">{d.counts.total}</span>
                  <span className="count count-new">{d.counts.new}</span>
                  <span className="count count-due">{d.counts.due}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="legend muted">
          <span className="count count-total">总数</span>
          <span className="count count-new">未学习</span>
          <span className="count count-due">到期</span>
        </p>
      </div>
    </div>
  )
}
