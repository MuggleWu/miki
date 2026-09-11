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
          GitHub 凭据失效（同步没在跑）：点这里去设置页换 PAT
        </button>
      ) : null}

      {dmg.damagedLines > 0 ? (
        <button className="banner" onClick={() => go({ kind: 'settings' })}>
          加载时跳过 {dmg.damagedLines} 条坏行
          {dmg.truncatedFiles.length > 0 ? `（${dmg.truncatedFiles.length} 个文件被截断）` : ''}
          ，点这里看细节
        </button>
      ) : null}

      <div className="page-body">
        {decks.length === 0 ? (
          <section className="empty">
            <p>还没有牌组。</p>
            <p className="muted">移动端 v1 的工作区由同步拉取建立；也可以先点右下角 + 新建一个牌组试试。</p>
          </section>
        ) : (
          <ul className="deck-list">
            {decks.map((d) => (
              <li key={d.id}>
                <button className="deck-row" onClick={() => go({ kind: 'study', deckId: d.id })}>
                  <span className="deck-name">{d.name}</span>
                  <span className="deck-counts">
                    <b className="c-new">{d.counts.new}</b>
                    <b className="c-due">{d.counts.due}</b>
                    <span className="c-total">{d.counts.total}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="legend muted">
          <b className="c-new">新</b> 未学 · <b className="c-due">待复习</b> · <span className="c-total">总数</span>
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
