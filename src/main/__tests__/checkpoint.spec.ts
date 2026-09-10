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
    w.updateCard(c.id, { front: '新正面', back: '新反面' })
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
    const lines = fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter((l) => l.includes('"front"'))
    fs.writeFileSync(file, lines.join('\n') + '\n')
    fs.rmSync(path.join(d, 'stats.json'), { force: true })

    const w2 = newWs(d)
    expect(w2.getCard(c.id)!.reps).toBe(1)
    expect(w2.getCard(c.id)!.fsrs).not.toBeNull()
  })
})

// 启动压实：delta 行数阈值原先只按「本会话追加次数」计（热加载还清零），小牌组的 delta
// 永远等不到阈值 → 「基文件 = 内容真理」长期不成立（真实数据 delta 停在 214 行不动，
// 约 209 张卡的当前内容只存在于 delta）。改成启动时按 delta 现存行数结算。
describe('启动压实积压的 delta', () => {
  /** 往 delta 里灌 n 行同一张卡的内容变更（绕过服务直接追加，模拟长期积累） */
  const pileDelta = (d: string, deck: string, cardId: string, n: number) => {
    const f = path.join(d, 'cards', `${deck}.delta.ndjson`)
    const rows = Array.from({ length: n }, (_, i) => JSON.stringify({ id: cardId, front: `积压 ${i}`, back: '' })).join(
      '\n'
    )
    fs.appendFileSync(f, rows + '\n')
    return f
  }

  it('delta 超过阈值：启动时压实，基文件含最新内容且 delta 被删除', () => {
    const d = tmp()
    const w = newWs(d)
    const deck = w.addDeck('积压组').id
    const c = w.addCard(deck, '原内容', '')
    const deltaFile = pileDelta(d, deck, c.id, 250)
    expect(fs.existsSync(deltaFile)).toBe(true)

    const w2 = newWs(d)
    // 压实后：delta 没了，基文件里是新内容
    expect(fs.existsSync(deltaFile)).toBe(false)
    expect(w2.getCard(c.id)!.front).toBe('积压 249') // 最后一行胜出
  })

  it('delta 未超阈值：不动文件（不无谓重写基文件）', () => {
    const d = tmp()
    const w = newWs(d)
    const deck = w.addDeck('小积压组').id
    const c = w.addCard(deck, '原内容', '')
    const deltaFile = pileDelta(d, deck, c.id, 5)
    const baseFile = path.join(d, 'cards', `${deck}.ndjson`)
    const baseBefore = readBytes(baseFile)!

    const w2 = newWs(d)
    expect(fs.existsSync(deltaFile)).toBe(true) // delta 保留
    expect(readBytes(baseFile)!.equals(baseBefore)).toBe(true) // 基文件一个字节没动
    expect(w2.getCard(c.id)!.front).toBe('积压 4')
  })

  it('反复启动不重复压实（压过一次之后第二次启动无写入）', () => {
    const d = tmp()
    const w = newWs(d)
    const deck = w.addDeck('只压一次').id
    const c = w.addCard(deck, '原内容', '')
    pileDelta(d, deck, c.id, 250)

    newWs(d) // 第一次启动压实
    const baseFile = path.join(d, 'cards', `${deck}.ndjson`)
    const afterFirst = readBytes(baseFile)!
    newWs(d) // 第二次启动：delta 已不存在，不该再重写基文件
    expect(readBytes(baseFile)!.equals(afterFirst)).toBe(true)
    expect(newWs(d).getCard(c.id)!.front).toBe('积压 249')
  })

  it('压实后内容与调度进度都不丢（delta 覆盖 + 事件重放）', () => {
    const d = tmp()
    const w = newWs(d)
    const deck = w.addDeck('不丢内容').id
    const c = w.addCard(deck, '原内容', '')
    w.answer(c.id, 3)
    const repsBefore = w.getCard(c.id)!.reps
    pileDelta(d, deck, c.id, 250)

    const w2 = newWs(d)
    expect(w2.getCard(c.id)!.front).toBe('积压 249')
    expect(w2.getCard(c.id)!.reps).toBe(repsBefore)
    expect(w2.getCard(c.id)!.fsrs).not.toBeNull()
  })
})

// 损坏检测：坏行本来被静默 continue 掉——app 照常启动、数字悄悄少算，用户无从察觉。
// 这几条钉住「如实报出」，其中「末尾缺换行」是追加写被中断的典型信号（僵尸行会被丢弃）。
describe('加载期损坏检测（damageReport）', () => {
  it('干净工作区报告为空', () => {
    const d = tmp()
    const w = newWs(d)
    const deck = w.addDeck('干净组').id
    w.addCard(deck, '正常卡', '')
    const rep = w.damageReport()
    expect(rep.damagedLines).toBe(0)
    expect(rep.truncatedFiles).toEqual([])
    expect(rep.files).toEqual([])
  })

  it('基文件里的坏行按条数报出，并给出文件名', () => {
    const d = tmp()
    const w = newWs(d)
    const deck = w.addDeck('坏行组').id
    w.addCard(deck, '甲', '')
    const file = path.join(d, 'cards', `${deck}.ndjson`)
    fs.appendFileSync(file, '{"id":"broken\n{"id":"also-broken\n')

    const rep = newWs(d).damageReport()
    expect(rep.damagedLines).toBe(2)
    expect(rep.files).toEqual([`cards/${deck}.ndjson`])
  })

  it('delta 里的坏行也报出（内容变更行丢失 = 编辑回退）', () => {
    const d = tmp()
    const w = newWs(d)
    const deck = w.addDeck('坏delta').id
    const c = w.addCard(deck, '原内容', '')
    w.updateCard(c.id, { front: '新内容' })
    fs.appendFileSync(path.join(d, 'cards', `${deck}.delta.ndjson`), '{"id":"半截')

    const w2 = newWs(d)
    expect(w2.damageReport().damagedLines).toBe(1)
    expect(w2.damageReport().files).toEqual([`cards/${deck}.delta.ndjson`])
  })

  it('review-log 里的坏行报出（事件丢失 = 统计少算）', () => {
    const d = tmp()
    const w = newWs(d)
    const deck = w.addDeck('坏日志').id
    const c = w.addCard(deck, '卡', '')
    w.answer(c.id, 3)
    const logFile = path.join(
      d,
      'review-log',
      `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}.ndjson`
    )
    fs.appendFileSync(logFile, '{"seq":99,"action":"ans\n')

    expect(newWs(d).damageReport().damagedLines).toBe(1)
  })

  it('末尾缺换行（追加写被中断）如实标记 truncatedFiles', () => {
    const d = tmp()
    const w = newWs(d)
    const deck = w.addDeck('截断组').id
    w.addCard(deck, '甲', '')
    const file = path.join(d, 'cards', `${deck}.ndjson`)
    // 去掉结尾换行：最后一条记录可能是半截写
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').trimEnd())

    const rep = newWs(d).damageReport()
    expect(rep.truncatedFiles).toEqual([`cards/${deck}.ndjson`])
    // 整行内容仍能读出来（只是标记不完整），所以不额外算坏行
    expect(rep.damagedLines).toBe(0)
  })

  it('坏行不影响其余数据：好行照常加载，只是被报出来', () => {
    const d = tmp()
    const w = newWs(d)
    const deck = w.addDeck('好坏混合').id
    const keep = w.addCard(deck, '保留卡', '')
    const file = path.join(d, 'cards', `${deck}.ndjson`)
    fs.appendFileSync(file, '不是 JSON\n')

    const w2 = newWs(d)
    expect(w2.getCard(keep.id)!.front).toBe('保留卡')
    expect(w2.damageReport().damagedLines).toBe(1)
  })
})
