// WorkspaceService 服务层单测：undo 语义、leech 自动暂停、重放一致性、损坏容错、配置持久化、计数入口
// api-server.spec 只间接覆盖 CRUD，这里直接盯服务层的不变量（重放 = 调度真理）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { WorkspaceService } from '../workspace'
import { DEFAULT_CONFIG } from '../../shared/types'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'miki-ws-test-'))
const newWs = (d: string) => {
  const w = new WorkspaceService()
  w.init(d)
  return w
}

const dirs: string[] = []
const tmpKept = () => {
  const d = tmp()
  dirs.push(d)
  return d
}

let dir: string
let ws: WorkspaceService
let deckId: string

beforeAll(() => {
  dir = tmpKept()
  ws = newWs(dir)
  deckId = ws.addDeck('服务层').id
})

afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

const queryAll = (w: WorkspaceService, kw: string) =>
  w.queryCards({ deckId: null, keywords: [kw], sort: [] })

describe('undo（会话内多步撤销）', () => {
  it('answer 撤销：fsrs 回 before、reps 回退，与重放语义一致', () => {
    const card = ws.addCard(deckId, 'undo answer', '')
    ws.answer(card.id, 3, 1000)
    expect(ws.getCard(card.id)!.reps).toBe(1)
    expect(ws.getCard(card.id)!.fsrs).not.toBeNull()

    const undone = ws.undo()
    expect(undone.restoredCardId).toBe(card.id)
    const c = ws.getCard(card.id)!
    expect(c.fsrs).toBeNull() // 新卡首次答题 before=null
    expect(c.reps).toBe(0)
    expect(c.lapses).toBe(0)
  })

  it('Again 撤销：lapses 回退，未撤销的那次答题保留', () => {
    const card = ws.addCard(deckId, 'undo again', '')
    ws.answer(card.id, 3)
    ws.answer(card.id, 1)
    expect(ws.getCard(card.id)!.lapses).toBe(1)
    ws.undo()
    const c = ws.getCard(card.id)!
    expect(c.lapses).toBe(0)
    expect(c.reps).toBe(1)
    expect(c.fsrs).not.toBeNull()
  })

  it('删除撤销：软删恢复并回到查询视图', () => {
    const card = ws.addCard(deckId, 'undo delete', '')
    ws.deleteCards([card.id])
    expect(queryAll(ws, 'undo delete').total).toBe(0)
    const undone = ws.undo()
    expect(undone.restoredCardId).toBe(card.id)
    expect(ws.getCard(card.id)!.deletedAt).toBeNull()
    expect(queryAll(ws, 'undo delete').total).toBe(1)
  })

  it('连续撤销多张卡，后答先撤', () => {
    const a = ws.addCard(deckId, 'multi a', '')
    const b = ws.addCard(deckId, 'multi b', '')
    ws.answer(a.id, 3)
    ws.answer(b.id, 3)
    const u1 = ws.undo()
    const u2 = ws.undo()
    expect(u1.restoredCardId).toBe(b.id)
    expect(u2.restoredCardId).toBe(a.id)
    expect(ws.getCard(a.id)!.fsrs).toBeNull()
    expect(ws.getCard(b.id)!.fsrs).toBeNull()
  })

  it('reset 后该卡撤销栈作废，其余不受影响', () => {
    const w = newWs(tmpKept())
    const d = w.addDeck('reset void').id
    const a = w.addCard(d, 'reset void a', '')
    w.answer(a.id, 3)
    const b = w.addCard(d, 'reset void b', '')
    w.answer(b.id, 3)
    w.resetProgress([a.id])
    expect(w.undo().restoredCardId).toBe(b.id)
    expect(w.undo().restoredCardId).toBeNull() // a 的栈项已被 reset 作废
    expect(w.getCard(a.id)!.reps).toBe(0)
  })

  it('空栈撤销返回空结果', () => {
    const w = newWs(tmpKept())
    expect(w.undo().restoredCardId).toBeNull()
  })
})

describe('leech 自动暂停', () => {
  it('lapses 达阈值暂停：不进队列、不进剩余计数、查询可见', () => {
    const w = newWs(tmpKept())
    const d = w.addDeck('leech 组').id
    w.saveConfig({ leechThreshold: 2 })
    const card = w.addCard(d, 'leech 卡', '')
    w.answer(card.id, 3)
    w.answer(card.id, 1)
    w.answer(card.id, 1)
    const c = w.getCard(card.id)!
    expect(c.lapses).toBe(2)
    expect(c.suspended).toBe(true)
    expect(queryAll(w, 'leech 卡').rows[0].suspended).toBe(true)
    const study = w.getStudy(d)
    expect(study.remaining).toBe(0)
    expect(study.card?.id).not.toBe(card.id)
  })

  it('阈值 0 关闭 leech', () => {
    const w = newWs(tmpKept())
    const d = w.addDeck('no leech').id
    w.saveConfig({ leechThreshold: 0 })
    const card = w.addCard(d, 'no leech 卡', '')
    for (let i = 0; i < 5; i++) w.answer(card.id, 1)
    expect(w.getCard(card.id)!.lapses).toBe(5)
    expect(w.getCard(card.id)!.suspended).toBe(false)
  })
})

describe('重放一致性（重启恢复）', () => {
  it('混合操作后重新 init，内存态与事件重放一致', () => {
    const d = tmpKept()
    const w = newWs(d)
    const deck = w.addDeck('重放组').id
    const other = w.addDeck('重放目标').id
    const c1 = w.addCard(deck, '重放一', 'b1')
    const c2 = w.addCard(deck, '重放二', 'b2')
    w.answer(c1.id, 3, 1200)
    w.answer(c1.id, 1)
    w.answer(c2.id, 4)
    w.setCardSuspended(c2.id, true)
    w.moveCards([c2.id], other)
    w.deleteCards([c2.id])
    w.undo()

    const w2 = newWs(d)
    const r1 = w2.getCard(c1.id)!
    expect(r1.reps).toBe(2)
    expect(r1.lapses).toBe(1)
    expect(r1.deckId).toBe(deck)
    expect(r1.fsrs).not.toBeNull()
    const r2 = w2.getCard(c2.id)!
    expect(r2.deckId).toBe(other)
    expect(r2.deletedAt).toBeNull()
    expect(r2.suspended).toBe(true)
    expect(r2.reps).toBe(1)
    // 历史事件不驻留内存：重启后新会话事件为空（调度状态已重放进卡片）
    expect(w2.events.length).toBe(0)
    expect(w2.decks.length).toBe(w.decks.length)
  })

  it('历史事件不驻留：todayCount 与热力图重启后与重启前一致', () => {
    const d = tmpKept()
    const w = newWs(d)
    const deck = w.addDeck('聚合组').id
    const c1 = w.addCard(deck, '聚合一', '')
    const c2 = w.addCard(deck, '聚合二', '')
    w.answer(c1.id, 3)
    w.answer(c2.id, 1)
    w.answer(c2.id, 3)
    const beforeToday = w.todayCount()
    const beforeHeat = w.getStats({ deckId: null, range: 'year' }).reviews.reduce((a, r) => a + r.total, 0)
    expect(beforeToday).toBe(3)
    expect(beforeHeat).toBe(3)
    // 撤销一张：热力图与今日计数同步回落
    w.undo()
    expect(w.todayCount()).toBe(2)
    expect(w.getStats({ deckId: null, range: 'year' }).reviews.reduce((a, r) => a + r.total, 0)).toBe(2)

    const w2 = newWs(d)
    expect(w2.todayCount()).toBe(2)
    expect(w2.getStats({ deckId: null, range: 'year' }).reviews.reduce((a, r) => a + r.total, 0)).toBe(2)
    const again = w2.getStats({ deckId: null, range: 'year' }).heatmap.find((x) => x.date === new Date().toLocaleDateString('sv-SE'))!
    expect(again.count).toBe(2) // undone 的 Again 不计（聚合已抵消）
    expect(w2.events.length).toBe(0)
  })
})

describe('suspend 事件化（暂停/解除走 review-log）', () => {
  it('暂停与解除重启后一致；同状态重复设置不产生新事件', () => {
    const d = tmpKept()
    const w = newWs(d)
    const deck = w.addDeck('suspend 事件').id
    const c = w.addCard(deck, 'suspend 卡', '')
    w.setCardSuspended(c.id, true)
    w.setCardSuspended(c.id, false)
    w.setCardSuspended(c.id, true)
    expect(w.getCard(c.id)!.suspended).toBe(true)
    const w2 = newWs(d)
    expect(w2.getCard(c.id)!.suspended).toBe(true)
    const evsBefore = w2.events.length
    w2.setCardSuspended(c.id, true)
    expect(w2.events.length).toBe(evsBefore)
  })

  it('leech 自动暂停走 suspend 事件，重启后保持暂停且不进队列', () => {
    const d = tmpKept()
    const w = newWs(d)
    const deck = w.addDeck('leech 事件').id
    w.saveConfig({ leechThreshold: 2 })
    const c = w.addCard(deck, 'leech 事件卡', '')
    w.answer(c.id, 3)
    w.answer(c.id, 1)
    w.answer(c.id, 1)
    expect(w.getCard(c.id)!.suspended).toBe(true)
    const w2 = newWs(d)
    expect(w2.getCard(c.id)!.suspended).toBe(true)
    expect(w2.getStudy(deck).card?.id).not.toBe(c.id)
  })

  it('reset 解除暂停：内存与重放一致', () => {
    const d = tmpKept()
    const w = newWs(d)
    const deck = w.addDeck('reset suspend').id
    const c = w.addCard(deck, 'reset suspend 卡', '')
    w.setCardSuspended(c.id, true)
    w.resetProgress([c.id])
    expect(w.getCard(c.id)!.suspended).toBe(false)
    expect(newWs(d).getCard(c.id)!.suspended).toBe(false)
  })

  it('suspend 不可撤销（不入会话撤销栈）', () => {
    const d = tmpKept()
    const w = newWs(d)
    const deck = w.addDeck('suspend undo').id
    const c = w.addCard(deck, 'suspend undo 卡', '')
    w.setCardSuspended(c.id, true)
    expect(w.undo().restoredCardId).toBeNull()
    expect(w.getCard(c.id)!.suspended).toBe(true)
  })
})

describe('损坏容错', () => {
  it('事件日志坏行跳过，好事件仍生效', () => {
    const d = tmpKept()
    const w = newWs(d)
    const deck = w.addDeck('坏事件').id
    const c = w.addCard(deck, '坏事件卡', '')
    w.answer(c.id, 3)
    const logDir = path.join(d, 'review-log')
    const file = fs.readdirSync(logDir).find((f) => f.endsWith('.ndjson'))!
    fs.appendFileSync(path.join(logDir, file), '{broken json line\n')
    const w2 = newWs(d)
    expect(w2.getCard(c.id)!.reps).toBe(1)
  })

  it('卡片文件坏行跳过', () => {
    const d = tmpKept()
    const w = newWs(d)
    const deck = w.addDeck('坏卡片').id
    const c = w.addCard(deck, '坏卡片卡', '')
    fs.appendFileSync(path.join(d, 'cards', `${deck}.ndjson`), '{broken\n')
    const w2 = newWs(d)
    expect(w2.getCard(c.id)).not.toBeNull()
  })

  it('config.json 损坏时回退默认配置', () => {
    const d = tmpKept()
    newWs(d)
    fs.writeFileSync(path.join(d, 'config.json'), '{broken')
    const w2 = newWs(d)
    expect(w2.config.theme).toBe(DEFAULT_CONFIG.theme)
    expect(w2.config.desiredRetention).toBe(DEFAULT_CONFIG.desiredRetention)
  })
})

describe('saveConfig', () => {
  it('study/browser 段深合并不丢其他字段', () => {
    const w = newWs(tmpKept())
    w.saveConfig({ study: { fontFamily: '', fontSize: 20 }, browser: { columns: ['front'] } })
    expect(w.config.study.fontSize).toBe(20)
    expect(w.config.study.fontFamily).toBe(DEFAULT_CONFIG.study.fontFamily)
    expect(w.config.browser.sort).toEqual(DEFAULT_CONFIG.browser.sort)
  })

  it('调度参数变化重建调度器，预览间隔随之变化', () => {
    const w = newWs(tmpKept())
    const d = w.addDeck('调度参数').id
    const card = w.addCard(d, '调度参数卡', '')
    w.answer(card.id, 3)
    const before = w.previewIntervals(card.id)
    w.saveConfig({ desiredRetention: 0.7 })
    const after = w.previewIntervals(card.id)
    expect(after[3]).toBeGreaterThan(before[3]) // 更低留存率 → 更长间隔
  })

  it('api token 首启生成并持久化，二次 init 不变', () => {
    const d = tmpKept()
    const w = newWs(d)
    const t1 = w.config.api.token
    expect(t1).not.toBe('')
    expect(newWs(d).config.api.token).toBe(t1)
  })
})

describe('计数与统计入口', () => {
  it('deckInfos 新卡计未学习；answer 后 todayCount 增加', () => {
    const w = newWs(tmpKept())
    const d = w.addDeck('计数组').id
    w.addCards(d, [
      { front: '计数一', back: '' },
      { front: '计数二', back: '' }
    ])
    const info = w.deckInfos().find((x) => x.id === d)!
    expect(info.counts.new).toBe(2)
    expect(info.counts.learning).toBe(0)
    expect(info.counts.review).toBe(0)

    const before = w.todayCount()
    w.answer(queryAll(w, '计数一').rows[0].id, 3)
    expect(w.todayCount()).toBe(before + 1)
  })

  it('删除牌组后卡片从所有视图消失且重启后仍不可见', () => {
    const d = tmpKept()
    const w = newWs(d)
    const deck = w.addDeck('将删组').id
    w.addCard(deck, '将删卡', '')
    w.deleteDeck(deck)
    expect(w.deckInfos().some((x) => x.id === deck)).toBe(false)
    expect(queryAll(w, '将删卡').total).toBe(0)
    expect(newWs(d).queryCards({ deckId: null, keywords: ['将删卡'], sort: [] }).total).toBe(0)
  })
})

describe('previewIntervals（评级预览）', () => {
  it('四档单调递增，且不改变卡片状态', () => {
    const w = newWs(tmpKept())
    const d = w.addDeck('预览组').id
    const card = w.addCard(d, '预览卡', '')
    w.answer(card.id, 3)
    const snap = w.getCard(card.id)!.fsrs
    const iv = w.previewIntervals(card.id)
    expect(iv).toHaveLength(4)
    expect(iv[0]).toBeLessThanOrEqual(iv[1])
    expect(iv[1]).toBeLessThanOrEqual(iv[2])
    expect(iv[2]).toBeLessThan(iv[3])
    expect(w.getCard(card.id)!.fsrs).toEqual(snap)
  })
})
