// 牌组页（首页）：今日已学 + 牌组列表 + 右下 FAB（新增卡片 / 新增牌组）。
// 点牌组直接进学习页——不设"牌组详情"中间页，与桌面端一致。
import { useState } from 'react'
import { useApp } from '../store'
import { useWorkspace } from '../use-workspace'
import { Sheet } from '../components/Sheet'
import { AddCardForm } from '../forms/AddCardForm'
import { AddDeckForm } from '../forms/AddDeckForm'

export function DecksPage(): JSX.Element {
  const ws = useWorkspace()
  const go = useApp((s) => s.go)
  // 抽屉挂在 App 里（左边缘右滑也要能拉起它），这里只负责把汉堡按钮接上去
  const setDrawer = useApp((s) => s.setDrawer)
  const [menu, setMenu] = useState(false)
  const [addCard, setAddCard] = useState(false)
  const [addDeck, setAddDeck] = useState(false)

  // 每次渲染直接算：卡片计数由调度索引增量维护，这里是 O(牌组数)
  const decks = ws.deckInfos()
  const today = ws.todayCount()
  const dmg = ws.damageReport()
  const sync = useApp((s) => s.sync)

  return (
    <>
      <div className="page-head">
        <button className="icon-btn" onClick={() => setDrawer(true)} aria-label="菜单">
          ☰
        </button>
        <h1>牌组</h1>
        <span className="head-note">今日已学 {today} 次</span>
      </div>

      {sync.status?.configured && sync.verify && !sync.verify.ok ? (
        <button className="banner" onClick={() => go({ kind: 'settings' })}>
          {sync.verify.kind === 'network'
            ? '连不上 GitHub（网络问题，凭据没坏）：点这里看详情'
            : 'GitHub 凭据或仓库配置有问题（同步没在跑）：点这里改'}
        </button>
      ) : null}

      {dmg.damagedLines > 0 ? (
        <button className="banner" onClick={() => go({ kind: 'settings' })}>
          加载时跳过 {dmg.damagedLines} 条坏行
          {dmg.truncatedFiles.length > 0 ? `（${dmg.truncatedFiles.length} 个文件被截断）` : ''}
          ，点这里看细节
        </button>
      ) : null}

      <div className="page-body with-fab">
        {decks.length === 0 ? (
          <section className="empty">
            <p>还没有牌组。</p>
            <p className="muted">点右下角 ＋ 新建一个；想用电脑上已有的牌组，先到设置里配好同步再拉取。</p>
          </section>
        ) : (
          <ul className="deck-list">
            {decks.map((d) => (
              <li key={d.id}>
                <button className="deck-row" onClick={() => go({ kind: 'study', deckId: d.id })}>
                  <span className="deck-name">{d.name}</span>
                  {/* 三个数与桌面端同序（总数 / 未学习 / 到期）、同色，为 0 时同样不显示 */}
                  <span className="deck-counts">
                    {d.counts.total > 0 ? <span className="count count-total">{d.counts.total}</span> : null}
                    {d.counts.new > 0 ? <span className="count count-new">{d.counts.new}</span> : null}
                    {d.counts.due > 0 ? <span className="count count-due">{d.counts.due}</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="legend muted">
          <span className="count count-total">总数</span>
          <span className="count count-new">未学习</span>
          <span className="count count-due">到期</span>
        </p>
      </div>

      <button className="fab" onClick={() => setMenu(true)} aria-label="新增">
        ＋
      </button>

      <Sheet open={menu} title="新增" onClose={() => setMenu(false)}>
        <button
          className="sheet-item"
          onClick={() => {
            setMenu(false)
            setAddCard(true)
          }}
        >
          新增卡片
        </button>
        <button
          className="sheet-item"
          onClick={() => {
            setMenu(false)
            setAddDeck(true)
          }}
        >
          新增牌组
        </button>
      </Sheet>

      {/* 抽屉内容按需挂载：表单的初始值（牌组列表、上次用的牌组）是在挂载那一刻算的，
          常驻挂载会让它一直停在"第一次打开时"的那份数据上 */}
      <Sheet open={addCard} title="新增卡片" onClose={() => setAddCard(false)}>
        {addCard ? <AddCardForm onDone={() => setAddCard(false)} /> : null}
      </Sheet>

      <Sheet open={addDeck} title="新增牌组" onClose={() => setAddDeck(false)}>
        {addDeck ? <AddDeckForm onDone={() => setAddDeck(false)} /> : null}
      </Sheet>
    </>
  )
}
