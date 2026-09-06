// 检查点写路径专项：基文件快照行、delta 覆盖/墓碑、stats.json 聚合检查点、调度类零卡片文件写
import { afterAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { WorkspaceService } from '../workspace'

const dirs: string[] = []
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'miki-ck-test-'))
  dirs.push(d)
  return d
}
const newWs = (d: string) => {
  const w = new WorkspaceService()
  w.init(d)
  return w
}
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

const readBytes = (p: string): Buffer | null => (fs.existsSync(p) ? fs.readFileSync(p) : null)

describe('检查点 + delta 写路径', () => {
  it('调度类操作（answer/undo/delete）不重写卡片基文件', () => {
    const d = tmp()
    const w = newWs(d)
    const deck = w.addDeck('零写').id
    const c = w.addCard(deck, '零写卡', '')
    const file = path.join(d, 'cards', `${deck}.ndjson`)
    const before = readBytes(file)!

    w.answer(c.id, 3)
    w.undo()
    w.deleteCards([c.id])
    w.undo()
    w.setCardSuspended(c.id, true)
    w.resetProgress([c.id])
    expect(readBytes(file)!.equals(before)).toBe(true) // 全程只有 add 时追加的那一次内容
  })

  it('update 走 delta：不压实重启内容一致；压实后 delta 清空', () => {
    const d = tmp()
    const w = newWs(d)
    const deck = w.addDeck('delta 组').id
    const c = w.addCard(deck, '原反面', '')
    w.updateCard(c.id, '新正面', '新反面')
    const deltaFile = path.join(d, 'cards', `${deck}.delta.ndjson`)
    expect(fs.existsSync(deltaFile)).toBe(true)

    let w2 = newWs(d) // delta 合并路径
    expect(w2.getCard(c.id)!.front).toBe('新正面')
    expect(w2.getCard(c.id)!.back).toBe('新反面')

    w2.compact()
    expect(fs.existsSync(deltaFile)).toBe(false)
    w2 = newWs(d) // 检查点快照路径
    expect(w2.getCard(c.id)!.front).toBe('新正面')
  })

  it('压实后重启：调度快照 + 增量事件重放结果一致', () => {
    const d = tmp()
    const w = newWs(d)
    const deck = w.addDeck('压实组').id
    const c1 = w.addCard(deck, '压实一', '')
    const c2 = w.addCard(deck, '压实二', '')
    w.answer(c1.id, 3)
    w.answer(c2.id, 1)
    w.setCardSuspended(c2.id, true)
    w.deleteCards([c1.id])
    w.undo()
    w.compact()

    const w2 = newWs(d)
    expect(w2.getCard(c1.id)!.reps).toBe(1)
    expect(w2.getCard(c1.id)!.deletedAt).toBeNull()
    expect(w2.getCard(c2.id)!.suspended).toBe(true)
    expect(w2.getCard(c2.id)!.lapses).toBe(1)
    expect(w2.getStudy(deck).remaining).toBe(w.getStudy(deck).remaining)
  })

  it('move 墓碑：跨牌组后源文件墓碑生效，目标无重复行；往返移动幂等', () => {
    const d = tmp()
    const w = newWs(d)
    const a = w.addDeck('源组').id
    const b = w.addDeck('目标组').id
    const c1 = w.addCard(a, '移动卡一', '')
    const c2 = w.addCard(a, '移动卡二', '')
    w.answer(c1.id, 3) // 带调度进度移动
    w.moveCards([c1.id, c2.id], b)
    let w2 = newWs(d)
    expect(w2.getCard(c1.id)!.deckId).toBe(b)
    expect(w2.getCard(c1.id)!.reps).toBe(1) // 调度进度保留
    expect(w2.getCard(c2.id)!.deckId).toBe(b)
    expect([...w2.cards.values()].filter((x) => x.front === '移动卡一').length).toBe(1)

    w2.moveCards([c1.id], a) // 往返
    w2 = newWs(d)
    expect(w2.getCard(c1.id)!.deckId).toBe(a)
    expect([...w2.cards.values()].filter((x) => x.front === '移动卡一').length).toBe(1)
  })

  it('stats.json 检查点：压实后聚合落盘，重启 = 检查点 + 增量事件', () => {
    const d = tmp()
    const w = newWs(d)
    const deck = w.addDeck('聚合检查点').id
    const cards = w.addCards(deck, [
      { front: '聚合一', back: '' },
      { front: '聚合二', back: '' },
      { front: '聚合三', back: '' }
    ])
    w.answer(cards[0].id, 3)
    w.answer(cards[1].id, 1)
    w.answer(cards[2].id, 3)
    w.compact() // stats.json 落盘 checkpointSeq=3
    expect(fs.existsSync(path.join(d, 'stats.json'))).toBe(true)

    w.answer(cards[0].id, 4) // 压实后新事件（增量重放补聚合）
    const total = w.getStats({ deckId: null, range: 'year' }).reviews.reduce((acc, r) => acc + r.total, 0)
    expect(total).toBe(4)
    expect(w.todayCount()).toBe(4)

    const w2 = newWs(d)
    expect(w2.getStats({ deckId: null, range: 'year' }).reviews.reduce((acc, r) => acc + r.total, 0)).toBe(4)
    expect(w2.todayCount()).toBe(4)
  })

  it('旧格式库兼容：无检查点 meta 的卡片文件全量重放启动', () => {
    const d = tmp()
    const w = newWs(d)
    const deck = w.addDeck('旧格式').id
    const c = w.addCard(deck, '旧格式卡', '')
    w.answer(c.id, 3)
    const file = path.join(d, 'cards', `${deck}.ndjson`)
    // 去掉可能存在的 meta 行，模拟老版本文件
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.includes('"front"'))
    fs.writeFileSync(file, lines.join('\n') + '\n')
    fs.rmSync(path.join(d, 'stats.json'), { force: true })

    const w2 = newWs(d)
    expect(w2.getCard(c.id)!.reps).toBe(1)
    expect(w2.getCard(c.id)!.fsrs).not.toBeNull()
  })
})
