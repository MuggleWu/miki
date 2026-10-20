// 首屏快照的解析：坏数据必须安静地退回"没有快照"，绝不能让启动失败。
//
// 这条口子的实际后果不是"少一屏数字"，而是"整个应用打不开"——快照是在 boot 之前读的，
// 解析抛错就会进 bootError 的全屏错误页。所以这里把各种畸形输入都钉死在 null。
import { describe, expect, it } from 'vitest'
import { parseDeckSnapshot, snapshotFrom } from './deck-snapshot'

const row = (id: string, name: string, total: number, nu: number, due: number): string =>
  `{"id":"${id}","name":"${name}","total":${total},"new":${nu},"due":${due}}`

describe('parseDeckSnapshot', () => {
  it('没有快照 / 空串 → null', () => {
    expect(parseDeckSnapshot(null)).toBeNull()
    expect(parseDeckSnapshot('')).toBeNull()
  })

  it('坏 JSON 与非对象 → null（不抛错）', () => {
    expect(parseDeckSnapshot('{oops')).toBeNull()
    expect(parseDeckSnapshot('42')).toBeNull()
    expect(parseDeckSnapshot('null')).toBeNull()
  })

  it('decks 不是数组、或一行都没有 → null', () => {
    expect(parseDeckSnapshot('{"at":1,"today":0,"decks":{}}')).toBeNull()
    expect(parseDeckSnapshot('{"at":1,"today":0,"decks":[]}')).toBeNull()
  })

  it('缺字段的行被丢掉，其余照常保留', () => {
    const raw = `{"at":1790000000000,"today":7,"decks":[${row('a', '牌组甲', 12, 7, 2)},{"id":"b"},${row('c', '牌组丙', 30, 0, 5)}]}`
    const snap = parseDeckSnapshot(raw)
    expect(snap?.decks.map((d) => d.id)).toEqual(['a', 'c'])
    expect(snap?.today).toBe(7)
  })

  it('at/today 不是数字时退化成 0，不影响牌组行', () => {
    const snap = parseDeckSnapshot(`{"decks":[${row('a', 'x', 1, 2, 3)}]}`)
    expect(snap?.at).toBe(0)
    expect(snap?.today).toBe(0)
    expect(snap?.decks).toHaveLength(1)
  })
})

describe('snapshotFrom', () => {
  it('逐项照抄 deckInfos 的计数口径（总数/未学习/到期）', () => {
    const snap = snapshotFrom(
      [
        { id: 'a', name: '牌组甲', counts: { total: 12, new: 7, due: 2 } },
        { id: 'b', name: '牌组乙', counts: { total: 30, new: 0, due: 5 } }
      ] as never,
      9
    )
    expect(snap.today).toBe(9)
    expect(snap.decks).toEqual([
      { id: 'a', name: '牌组甲', total: 12, new: 7, due: 2 },
      { id: 'b', name: '牌组乙', total: 30, new: 0, due: 5 }
    ])
  })
})
