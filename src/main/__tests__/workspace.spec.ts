// WorkspaceService 服务层单测：undo 语义、leech 自动暂停、重放一致性、损坏容错、配置持久化、计数入口
// api-server.spec 只间接覆盖 CRUD，这里直接盯服务层的不变量（重放 = 调度真理）。
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { WorkspaceService } from '../workspace'
import { DEFAULT_CONFIG } from '../../shared/types'
import type { CardSnapshot, ReviewEvent } from '../../shared/types'

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

const queryAll = (w: WorkspaceService, kw: string) => w.queryCards({ deckId: null, keywords: [kw], sort: [] })

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

  it('undo 还原 leech 自动暂停：撤销触发暂停的 Again 解除暂停并回到队列；重启重放一致', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-06T10:00:00'))
      const d0 = tmpKept()
      const w = newWs(d0)
      const d = w.addDeck('leech 撤销组').id
      w.saveConfig({ leechThreshold: 2 })
      const card = w.addCard(d, 'leech 撤销卡', '')
      w.answer(card.id, 3)
      w.answer(card.id, 1)
      w.answer(card.id, 1) // lapses=2 达阈值 → 自动暂停
      expect(w.getCard(card.id)!.suspended).toBe(true)

      const r = w.undo() // 撤销最后一次 Again → 该次触发的暂停一并解除
      expect(r.restoredCardId).toBe(card.id)
      const c = w.getCard(card.id)!
      expect(c.suspended).toBe(false)
      expect(c.lapses).toBe(1)
      // 回到队列：卡回到倒数第二次 Again 的状态（due +1 分钟），到点后重新可取
      expect(w.deckInfos().find((x) => x.id === d)!.counts.due).toBe(0)
      vi.setSystemTime(new Date('2026-10-06T10:11:00'))
      expect(w.getStudy(d).card?.id).toBe(card.id)

      // 重放一致：重启后仍应保持未暂停
      const w2 = newWs(d0)
      expect(w2.getCard(card.id)).toMatchObject({ suspended: false, lapses: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('undo 不还原与该 answer 无关的暂停：手动暂停后再答题，撤销不动暂停态', () => {
    const w = newWs(tmpKept())
    const d = w.addDeck('手动暂停组').id
    w.saveConfig({ leechThreshold: 2 })
    const card = w.addCard(d, '手动暂停卡', '')
    w.setCardSuspended(card.id, true) // 手动暂停（事件在 answer 之前）
    w.answer(card.id, 1)
    w.undo()
    expect(w.getCard(card.id)!.suspended).toBe(true) // 暂停态保留

    // 手动暂停在 leech 自动暂停之后：最后 suspend 不是自动事件，同样不还原
    const w3 = newWs(tmpKept())
    const d3 = w.addDeck('后置手动组').id
    w3.saveConfig({ leechThreshold: 1 })
    const c3 = w3.addCard(d3, '后置手动卡', '')
    w3.answer(c3.id, 1) // lapses=1 → 自动暂停
    w3.setCardSuspended(c3.id, false) // 手动解除（最后 suspend 事件）
    w3.setCardSuspended(c3.id, true)
    w3.undo()
    expect(w3.getCard(c3.id)!.suspended).toBe(true)
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
    const again = w2
      .getStats({ deckId: null, range: 'year' })
      .heatmap.find((x) => x.date === new Date().toLocaleDateString('sv-SE'))!
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

  it('window 状态：旧 config 缺键补默认，保存后跨 init 恢复', () => {
    const d = tmpKept()
    const w = newWs(d)
    expect(w.config.window).toEqual(DEFAULT_CONFIG.window)
    w.saveConfig({ window: { x: 40, y: 60, width: 1024, height: 700, maximized: false } })
    const w2 = newWs(d)
    expect(w2.config.window).toEqual({ x: 40, y: 60, width: 1024, height: 700, maximized: false })
  })
})

describe('loadConfig 写盘节流（内容未变不回写）', () => {
  const cfgFile = (d: string) => path.join(d, 'config.json')
  const readCfg = (d: string) => fs.readFileSync(cfgFile(d), 'utf-8')
  /** mtime 拨回 2000 年：loadConfig 若回写，mtime 必然跳回当前时间；比同毫秒比较更可靠 */
  const backdate = (d: string) => {
    const past = new Date(2000, 0, 1)
    fs.utimesSync(cfgFile(d), past, past)
  }
  const isBackdated = (d: string) => new Date(fs.statSync(cfgFile(d)).mtimeMs).getFullYear() === 2000

  it('首启生成 config.json（含 token），二次 init 内容逐字节不变且不回写', () => {
    const d = tmpKept()
    newWs(d)
    expect(JSON.parse(readCfg(d)).api.token).not.toBe('')
    const first = readCfg(d)
    backdate(d)
    const w2 = newWs(d)
    expect(readCfg(d)).toBe(first)
    expect(isBackdated(d)).toBe(true) // 未回写：mtime 停在拨回的旧时刻
    expect(w2.config.api.token).toBe(JSON.parse(first).api.token) // token 保留
  })

  it('热加载链同口径：reloadFromDisk 不动无变化的 config.json', () => {
    const d = tmpKept()
    const w = newWs(d)
    backdate(d)
    w.reloadFromDisk()
    expect(isBackdated(d)).toBe(true)
  })

  it('盘上内容偏离序列化结果时重写（手改紧凑 JSON → 规范化 2 空格并补全默认键）', () => {
    const d = tmpKept()
    newWs(d)
    fs.writeFileSync(cfgFile(d), '{"theme":"dark"}')
    backdate(d)
    newWs(d)
    expect(isBackdated(d)).toBe(false) // 发生了回写
    const onDisk = JSON.parse(readCfg(d))
    expect(onDisk.theme).toBe('dark') // 手改内容保留（合并语义）
    expect(onDisk.desiredRetention).toBe(DEFAULT_CONFIG.desiredRetention) // 默认键补全
  })

  it('损坏 config.json 仍被默认值重写为合法 JSON', () => {
    const d = tmpKept()
    newWs(d)
    fs.writeFileSync(cfgFile(d), '{broken')
    const w2 = newWs(d)
    expect(() => JSON.parse(readCfg(d))).not.toThrow()
    expect(w2.config.theme).toBe(DEFAULT_CONFIG.theme)
  })

  it('跳过回写路径上权限收敛 0600 仍执行', () => {
    const d = tmpKept()
    newWs(d)
    const file = cfgFile(d)
    fs.chmodSync(file, 0o644)
    backdate(d)
    newWs(d) // 内容未变 → 走跳过回写路径
    expect(isBackdated(d)).toBe(true)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('overrides 传入即偏离盘上内容，触发回写', () => {
    const d = tmpKept()
    newWs(d)
    backdate(d)
    const w = new WorkspaceService()
    w.init(d, { theme: 'dark' })
    expect(isBackdated(d)).toBe(false)
    expect(JSON.parse(readCfg(d)).theme).toBe('dark')
    expect(w.config.theme).toBe('dark')
  })
})

describe('计数与统计入口', () => {
  it('统计缓存在非事件写路径（加卡/移卡/删牌组）后失效：新卡数与牌组归属即时可见', () => {
    const w = newWs(tmpKept())
    const d1 = w.addDeck('缓存甲').id
    const d2 = w.addDeck('缓存乙').id
    w.addCards(d1, [{ front: '缓存一', back: '' }])
    // 预热缓存（全库 + d1 两把键），此后加卡不推 seq，必须靠显式失效
    expect(w.getStats({ deckId: null, range: 'year' }).stateCounts.new).toBe(1)
    expect(w.getStats({ deckId: d1, range: 'year' }).stateCounts.new).toBe(1)

    w.addCards(d1, [{ front: '缓存二', back: '' }])
    expect(w.getStats({ deckId: null, range: 'year' }).stateCounts.new).toBe(2)
    expect(w.getStats({ deckId: d1, range: 'year' }).stateCounts.new).toBe(2)

    w.addCard(d2, '缓存三', '')
    expect(w.getStats({ deckId: null, range: 'year' }).stateCounts.new).toBe(3)
    expect(w.getStats({ deckId: d2, range: 'year' }).stateCounts.new).toBe(1)

    // 移卡跨牌组：d1 减、d2 增，缓存键（seq 不变）感知不到 deckId 变化
    const moved = queryAll(w, '缓存二').rows[0]
    w.moveCards([moved.id], d2)
    expect(w.getStats({ deckId: d1, range: 'year' }).stateCounts.new).toBe(1)
    expect(w.getStats({ deckId: d2, range: 'year' }).stateCounts.new).toBe(2)
  })

  it('deckInfos 三列口径：新卡计未学习；answer 后 todayCount 增加', () => {
    const w = newWs(tmpKept())
    const d = w.addDeck('计数组').id
    w.addCards(d, [
      { front: '计数一', back: '' },
      { front: '计数二', back: '' }
    ])
    const info = w.deckInfos().find((x) => x.id === d)!
    expect(info.counts).toEqual({ total: 2, new: 2, due: 0 })

    const before = w.todayCount()
    w.answer(queryAll(w, '计数一').rows[0].id, 3)
    expect(w.todayCount()).toBe(before + 1)
  })

  it('deckInfos 未建堆单趟扫描与建堆逐组计算同口径：多牌组、暂停、软删、跨组混合', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-06T10:00:00'))
      const w = newWs(tmpKept())
      const d1 = w.addDeck('扫描甲').id
      const d2 = w.addDeck('扫描乙').id
      const [a1, b1, c1] = w.addCards(d1, [
        { front: '甲一', back: '' },
        { front: '甲二', back: '' },
        { front: '甲三', back: '' }
      ])
      const [a2] = w.addCards(d2, [
        { front: '乙一', back: '' },
        { front: '乙二', back: '' }
      ])

      // a1 越过学习步长到期；a2 未到期；b1 暂停；c1 软删
      w.answer(a1.id, 3)
      w.answer(a2.id, 4) // Easy 毕业，due 在数日后
      w.setCardSuspended(b1.id, true)
      w.deleteCards([c1.id])

      vi.setSystemTime(new Date('2026-10-06T10:11:00')) // a1 到期
      const before = w.deckInfos().map((x) => [x.id, x.counts.due] as const)

      w.getStudy(d1)
      w.getStudy(d2) // 两堆都建：deckInfos 转入 dueNowOf 逐组路径
      const after = w.deckInfos().map((x) => [x.id, x.counts.due] as const)
      expect(after).toEqual(before)
      expect(before).toContainEqual([d1, 1]) // 只 a1 到期
      expect(before).toContainEqual([d2, 0]) // a2 未到期，暂停/软删不数
    } finally {
      vi.useRealTimers()
    }
  })

  it('首页三列（总数/未学习/到期）：总数含暂停卡；到期只数此刻已到期的学习/复习卡（用户痛点：学习中≠能刷）', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-06T10:00:00'))
      const w = newWs(tmpKept())
      const d = w.addDeck('三列组').id
      const [a, b] = w.addCards(d, [
        { front: '列一', back: '' },
        { front: '列二', back: '' }
      ])
      const info = () => w.deckInfos().find((x) => x.id === d)!
      expect(info().counts).toEqual({ total: 2, new: 2, due: 0 })

      w.answer(a.id, 3) // 进入学习流：due = +10min 学习步长，此刻未到期
      expect(info().counts).toEqual({ total: 2, new: 1, due: 0 })
      expect(w.getStudy(d).card!.id).not.toBe(a.id) // 取卡也不出它：旧「学习中」列的值就是这种错觉来源

      vi.setSystemTime(new Date('2026-10-06T10:11:00')) // 越过学习步长 → 到期
      expect(info().counts).toEqual({ total: 2, new: 1, due: 1 })
      expect(w.getStudy(d).card!.id).toBe(a.id)

      w.setCardSuspended(b.id, true) // 暂停：总数仍在（牌组成员），未学习归零
      expect(info().counts).toEqual({ total: 2, new: 0, due: 1 })
      w.setCardSuspended(b.id, false)
      expect(info().counts).toEqual({ total: 2, new: 1, due: 1 })

      w.deleteCards([b.id])
      expect(info().counts).toEqual({ total: 1, new: 0, due: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('到期随时间推进自动增长：次日复习卡今晨为 0，到点后计入（假时钟）', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-06T10:00:00'))
      const w = newWs(tmpKept())
      const d = w.addDeck('推进组').id
      const c = w.addCard(d, '推进卡', '')
      w.answer(c.id, 4) // Easy 毕业 → review，due 在数日后
      expect(w.deckInfos().find((x) => x.id === d)!.counts.due).toBe(0)
      expect(w.deckInfos().find((x) => x.id === d)!.counts.total).toBe(1)

      vi.setSystemTime(new Date('2026-11-06T10:00:00')) // +31 天，跨天重建索引
      expect(w.deckInfos().find((x) => x.id === d)!.counts.due).toBe(1)
      expect(w.getStudy(d).card!.id).toBe(c.id)
    } finally {
      vi.useRealTimers()
    }
  })

  it('到期列与取卡一致：堆已构建（进过学习页）后 due-now 计数仍准确，undo/重复条目不重复计', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-06T10:00:00'))
      const w = newWs(tmpKept())
      const d = w.addDeck('堆遍历组').id
      const [a, b] = w.addCards(d, [
        { front: '堆一', back: '' },
        { front: '堆二', back: '' }
      ])
      w.answer(a.id, 3) // 学习中，due +10min
      w.getStudy(d) // ensureBuilt：之后 deckInfos 走堆遍历路径
      expect(w.deckInfos().find((x) => x.id === d)!.counts.due).toBe(0)

      vi.setSystemTime(new Date('2026-10-06T10:11:00'))
      expect(w.deckInfos().find((x) => x.id === d)!.counts.due).toBe(1)

      w.answer(b.id, 2) // b 也进入学习流，due +1min（第一步长）
      w.undo() // 撤销 → b 回新卡：堆里同时存在 b 的新旧条目
      const counts = w.deckInfos().find((x) => x.id === d)!.counts
      expect(counts).toEqual({ total: 2, new: 1, due: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('totalAnswered 历史累计：undo 抵消，跨天累加', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-06T10:00:00'))
      const w = newWs(tmpKept())
      const d = w.addDeck('累计组').id
      const [c1, c2] = w.addCards(d, [
        { front: '累计一', back: '' },
        { front: '累计二', back: '' }
      ])
      w.answer(c1.id, 3)
      w.answer(c2.id, 3)
      expect(w.totalAnswered()).toBe(2)
      w.undo()
      expect(w.totalAnswered()).toBe(1) // undo 抵消今日一笔
      vi.setSystemTime(new Date('2026-10-07T10:00:00')) // 次日再答一笔
      const c3 = w.addCard(d, '累计三', '')
      w.answer(c3.id, 3)
      expect(w.todayCount()).toBe(1) // 次日计数独立
      expect(w.totalAnswered()).toBe(2) // 累计跨天相加
    } finally {
      vi.useRealTimers()
    }
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

describe('工作区热加载（外部变更，git pull / 他机写入）', () => {
  it('外部追加新卡行 → pollOnce 后内存态同步，且只通知一次', () => {
    const d = tmpKept()
    const w = newWs(d)
    const deck = w.addDeck('热加载组')
    let notified = 0
    w.onExternalChange(() => notified++)
    // 模拟 git pull：另一台机器直接向基文件追加新卡行
    const ext = {
      id: 'ext-1',
      front: '外部新增',
      back: '外部答案',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deletedAt: null,
      suspended: false
    }
    fs.appendFileSync(path.join(d, 'cards', `${deck.id}.ndjson`), JSON.stringify(ext) + '\n', 'utf-8')
    w.pollOnce()
    expect(notified).toBe(1)
    expect(w.getCard('ext-1')).not.toBeNull()
    expect(queryAll(w, '外部新增').rows.some((r) => r.id === 'ext-1')).toBe(true)
    // 无新变化：再次轮询不重复通知
    w.pollOnce()
    expect(notified).toBe(1)
  })

  it('外部 answer 事件（他机刷卡）→ 重放后调度/todayCount 同步', () => {
    const d = tmpKept()
    const w = newWs(d)
    const deck = w.addDeck('异机组')
    const card = w.addCard(deck.id, '题', '答')
    const now = Date.now()
    const after: CardSnapshot = {
      state: 2,
      step: null,
      stability: 5,
      difficulty: 5,
      due: now + 86_400_000,
      lastReview: now
    }
    const ev: ReviewEvent = {
      seq: 0,
      t: now,
      action: 'answer',
      cardId: card.id,
      deckId: deck.id,
      rating: 4,
      before: null,
      after
    }
    const p = (n: number) => String(n).padStart(2, '0')
    const file = path.join(d, 'review-log', `${new Date().getFullYear()}-${p(new Date().getMonth() + 1)}.ndjson`)
    fs.appendFileSync(file, JSON.stringify(ev) + '\n', 'utf-8')
    w.pollOnce()
    const c = w.getCard(card.id)!
    expect(c.fsrs).toEqual(after)
    expect(c.reps).toBe(1)
    expect(w.todayCount()).toBe(1)
  })

  it('外部 decks.json 变更（新牌组）→ pollOnce 后可见', () => {
    const d = tmpKept()
    const w = newWs(d)
    const newDeck = { id: 'ext-deck', name: '外部牌组', order: 0, createdAt: Date.now(), deletedAt: null }
    const decks = JSON.parse(fs.readFileSync(path.join(d, 'decks.json'), 'utf-8'))
    fs.writeFileSync(path.join(d, 'decks.json'), JSON.stringify([...decks, newDeck], null, 2), 'utf-8')
    w.pollOnce()
    expect(w.deckInfos().some((x) => x.id === 'ext-deck')).toBe(true)
  })

  it('自写豁免：本机 addCard/answer 后 pollOnce 不误判外部变更', () => {
    const d = tmpKept()
    const w = newWs(d)
    let notified = 0
    w.onExternalChange(() => notified++)
    const deck = w.addDeck('本地组')
    const card = w.addCard(deck.id, '本地卡', '')
    w.answer(card.id, 3)
    w.pollOnce()
    expect(notified).toBe(0)
  })

  it('外部变更重载后会话撤销栈作废（undo 无操作）', () => {
    const d = tmpKept()
    const w = newWs(d)
    const deck = w.addDeck('撤销组')
    const card = w.addCard(deck.id, 'a', 'b')
    w.answer(card.id, 3)
    // 外部变更（追加一行新卡）触发重载
    const ext = {
      id: 'ext-2',
      front: '扰动',
      back: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deletedAt: null,
      suspended: false
    }
    fs.appendFileSync(path.join(d, 'cards', `${deck.id}.ndjson`), JSON.stringify(ext) + '\n', 'utf-8')
    w.pollOnce()
    const r = w.undo()
    expect(r.restoredCardId).toBeNull()
  })
})

describe('部分更新（updateCard/updateCards 未提供字段保留原值）', () => {
  it('lowerCache 失效：改面后旧词不再命中、新词命中，改回恢复', () => {
    const d = tmpKept()
    const w = newWs(d)
    const deck = w.addDeck('小写缓存').id
    const card = w.addCard(deck, 'Old Front', '')
    const q = (kw: string) => queryAll(w, kw).rows.length
    // 预热缓存：旧词命中
    expect(q('old')).toBe(1)
    w.updateCard(card.id, { front: 'New Front' })
    // 缓存若不失效：旧词仍命中（脏读）、新词搜不到
    expect(q('old')).toBe(0)
    expect(q('new')).toBe(1)
    w.updateCard(card.id, { front: 'Old Front' })
    expect(q('old')).toBe(1)
    // 批量路径同样失效
    w.updateCards([{ cardId: card.id, front: 'Batch Front' }])
    expect(q('old')).toBe(0)
    expect(q('batch')).toBe(1)
  })

  it('单卡：只传 back，front 保留', () => {
    const d = tmpKept()
    const w = newWs(d)
    const deck = w.addDeck('部分更新')
    const card = w.addCard(deck.id, '旧正面', '旧背面')
    const updated = w.updateCard(card.id, { back: '新背面' })
    expect(updated).toMatchObject({ front: '旧正面', back: '新背面' })
    // 重放后依然一致（delta 行是全量内容，服务层负责合并 patch）
    const w2 = newWs(d)
    expect(w2.getCard(card.id)).toMatchObject({ front: '旧正面', back: '新背面' })
  })

  it('批量：逐条部分更新 + 空串显式清空 + missing 计数', () => {
    const d = tmpKept()
    const w = newWs(d)
    const deck = w.addDeck('部分更新批量')
    const a = w.addCard(deck.id, 'A1', 'A2')
    const b = w.addCard(deck.id, 'B1', 'B2')
    const r = w.updateCards([
      { cardId: a.id, front: 'A1改' },
      { cardId: b.id, back: '' },
      { cardId: 'missing', front: 'x' }
    ])
    expect(r).toEqual({ updated: 2, missing: 1 })
    expect(w.getCard(a.id)).toMatchObject({ front: 'A1改', back: 'A2' })
    expect(w.getCard(b.id)).toMatchObject({ front: 'B1', back: '' })
  })

  it('软删卡拒改：单卡返回 null，批量计入 missing', () => {
    const d = tmpKept()
    const w = newWs(d)
    const deck = w.addDeck('软删拒改')
    const a = w.addCard(deck.id, '删前正面', '删前背面')
    const b = w.addCard(deck.id, '保留卡', '')
    w.deleteCards([a.id])

    expect(w.updateCard(a.id, { front: '不该生效' })).toBeNull()
    expect(w.getCard(a.id)).toMatchObject({ front: '删前正面', back: '删前背面' })

    const r = w.updateCards([
      { cardId: a.id, front: '不该生效' },
      { cardId: b.id, front: '生效' }
    ])
    expect(r).toEqual({ updated: 1, missing: 1 })
  })

  it('空 patch 为 no-op：不更新 updatedAt、不追加 delta 行', () => {
    const d = tmpKept()
    const w = newWs(d)
    const deck = w.addDeck('空补丁')
    const a = w.addCard(deck.id, 'A', 'B')
    const beforeUpdated = w.getCard(a.id)!.updatedAt
    const deltaFile = path.join(d, 'cards', `${deck.id}.delta.ndjson`)

    expect(w.updateCard(a.id, {})).not.toBeNull()
    const r = w.updateCards([{ cardId: a.id }, { cardId: a.id }])
    expect(r).toEqual({ updated: 0, missing: 0 })
    expect(w.getCard(a.id)!.updatedAt).toBe(beforeUpdated)
    if (fs.existsSync(deltaFile)) {
      expect(fs.readFileSync(deltaFile, 'utf-8').trim()).toBe('') // 没有任何 delta 行
    }
  })
})
