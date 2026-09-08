// 首页（H 域）：牌组表、选中态、行操作、今日统计、创建牌组；数字列宽可拖，三列口径=总数/未学习/到期
import { useState } from 'react'
import { sortedDecks, useApp } from '../store'
import { PromptModal } from '../components/PromptModal'
import { ColResizer } from '../components/drag'

type Menu = { x: number; y: number; deckId: string; name: string } | null
type Modal = 'create' | { rename: string; name: string } | { delete: string; name: string } | null

export function Home() {
  const decks = useApp((s) => s.decks)
  const todayCount = useApp((s) => s.todayCount)
  const totalCount = useApp((s) => s.totalCount)
  const selectedDeckId = useApp((s) => s.selectedDeckId)
  const homeColWidths = useApp((s) => s.homeColWidths)
  const setHomeColWidth = useApp((s) => s.setHomeColWidth)
  const reload = useApp((s) => s.reload)
  const enterStudy = useApp((s) => s.enterStudy)
  const openBrowser = useApp((s) => s.openBrowser)

  const [menu, setMenu] = useState<Menu>(null)
  const [modal, setModal] = useState<Modal>(null)

  const closeMenu = () => setMenu(null)

  return (
    <div className="home" onClick={closeMenu}>
      <table className="deck-table" style={{ tableLayout: 'fixed' }}>
        <colgroup>
          <col />
          {homeColWidths.map((w, i) => (
            <col key={i} style={{ width: w }} />
          ))}
          <col style={{ width: 44 }} />
        </colgroup>
        <thead>
          <tr>
            <th>牌组</th>
            <th className="num" style={{ textAlign: 'center' }}>
              总数
              <ColResizer width={homeColWidths[0]} onResize={(w) => setHomeColWidth(0, w)} />
            </th>
            <th className="num" style={{ textAlign: 'center' }}>
              未学习
              <ColResizer width={homeColWidths[1]} onResize={(w) => setHomeColWidth(1, w)} />
            </th>
            <th className="num" style={{ textAlign: 'center' }}>
              到期
              <ColResizer width={homeColWidths[2]} onResize={(w) => setHomeColWidth(2, w)} />
            </th>
            <th style={{ width: 44 }}></th>
          </tr>
        </thead>
        <tbody>
          {decks.length === 0 && (
            <tr>
              <td colSpan={5} style={{ cursor: 'default', color: 'var(--text-dim)' }}>
                还没有牌组，点击右下角「创建牌组」开始
              </td>
            </tr>
          )}
          {sortedDecks(decks).map((d) => (
            <tr
              key={d.id}
              className={d.id === selectedDeckId ? 'selected' : undefined}
              onClick={() => enterStudy(d.id)}
              title="点击进入学习"
            >
              <td>{d.name}</td>
              <td className="num" style={{ textAlign: 'center' }}>
                {d.counts.total > 0 ? <span className="badge badge-total">{d.counts.total}</span> : 0}
              </td>
              <td className="num" style={{ textAlign: 'center' }}>
                {d.counts.new > 0 ? <span className="badge badge-new">{d.counts.new}</span> : 0}
              </td>
              <td className="num" style={{ textAlign: 'center' }}>
                {d.counts.due > 0 ? <span className="badge badge-due">{d.counts.due}</span> : 0}
              </td>
              <td
                onClick={(e) => {
                  e.stopPropagation()
                  setMenu((m) => (m?.deckId === d.id ? null : { x: e.clientX, y: e.clientY, deckId: d.id, name: d.name }))
                }}
              >
                <span style={{ color: 'var(--text-dim)', cursor: 'pointer', letterSpacing: 2 }}>⋯</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="home-footer">
        <div className="home-footer-left">
          <div className="home-stats">
            今天已学习 <b>{todayCount}</b> 张
            <span className="home-stats-dot">·</span>
            总共已学习 <b>{totalCount}</b> 张
          </div>
          <div className="home-hints">
            <span><kbd className="kbd">S</kbd> 学习</span>
            <span><kbd className="kbd">A</kbd> 添加</span>
            <span><kbd className="kbd">B</kbd> 卡片库</span>
            <span><kbd className="kbd">T</kbd> 统计</span>
            <span><kbd className="kbd">D</kbd> 回首页</span>
          </div>
        </div>
        <button className="primary" onClick={() => setModal('create')}>
          创建牌组
        </button>
      </div>

      {menu && (
        <div className="rowmenu" style={{ left: menu.x - 90, top: menu.y + 10 }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => setModal({ rename: menu.deckId, name: menu.name })}>重命名</button>
          <button
            className="danger"
            onClick={() => {
              setModal({ delete: menu.deckId, name: menu.name })
              closeMenu()
            }}
          >
            删除
          </button>
        </div>
      )}

      {modal === 'create' && (
        <PromptModal
          title="创建牌组"
          placeholder="牌组名称"
          onConfirm={async (name) => {
            await window.miki.addDeck(name)
            await reload()
            setModal(null)
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal && typeof modal === 'object' && 'rename' in modal && (
        <PromptModal
          title="重命名牌组"
          initialValue={modal.name}
          onConfirm={async (name) => {
            await window.miki.renameDeck(modal.rename, name)
            await reload()
            setModal(null)
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal && typeof modal === 'object' && 'delete' in modal && (
        <PromptModal
          title={`删除牌组「${modal.name}」？`}
          confirmText="删除"
          danger
          placeholder="输入任意内容确认"
          onConfirm={async () => {
            await window.miki.deleteDeck(modal.delete)
            await reload()
            openBrowser(null)
            setModal(null)
          }}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  )
}
