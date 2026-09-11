// 合并判定与行并集的用例。这一段是同步里唯一"错了会丢数据"的逻辑，
// 所以覆盖的重点不是正常路径，而是**什么时候必须停**。
import { describe, expect, it } from 'vitest'
import { linesOf, mergeFile, summarize, unionLines, validateUnion } from './merge'

// 真实形态的行：NDJSON 每行都是 JSON，校验器据此拦"合出来的坏行"，所以用例也用 JSON
const row = (id: string, extra = ''): string => `{"id":"${id}"${extra}}`
const j = (...ids: string[]): string => ids.map((i) => row(i)).join('\n') + '\n'

describe('mergeFile 判定', () => {
  it('两侧一致 → skip', () => {
    const r = mergeFile({ path: 'a.ndjson', local: j('x'), remote: j('x') })
    expect(r.action).toBe('skip')
  })

  it('远端没有这个文件 → 推本地新建的文件', () => {
    const r = mergeFile({ path: 'a.ndjson', local: j('x'), remote: null })
    expect(r.action).toBe('keep-local')
  })

  it('本地没有这个文件 → 直接用远端（首次同步的主路径）', () => {
    const r = mergeFile({ path: 'a.ndjson', local: null, remote: j('x', 'y') })
    expect(r.action).toBe('take-remote')
    expect(r.content).toBe(j('x', 'y'))
  })

  it('本地是远端的严格延伸 → 纯追加，只推不合并', () => {
    const r = mergeFile({ path: 'a.ndjson', local: j('x', 'y', 'z'), remote: j('x', 'y') })
    expect(r.action).toBe('keep-local')
    expect(r.reason).toContain('纯追加')
  })

  it('远端是本地的严格延伸 → 纯追加，直接拉取覆盖', () => {
    const r = mergeFile({ path: 'a.ndjson', local: j('x'), remote: j('x', 'y') })
    expect(r.action).toBe('take-remote')
  })

  it('两侧各自追加 → 行并集，远端为骨架、本地新增接在末尾', () => {
    const r = mergeFile({ path: 'a.ndjson', local: j('x', 'L1'), remote: j('x', 'R1') })
    expect(r.action).toBe('union')
    expect(r.content).toBe(j('x', 'R1', 'L1'))
    expect(r.detail).toEqual({ remote: 2, local: 2, merged: 3, appended: 1 })
  })

  it('两侧都有的同一行只保留一份（按次数相抵）', () => {
    const r = mergeFile({ path: 'a.ndjson', local: j('x', 'same', 'L1'), remote: j('x', 'R1', 'same') })
    expect(r.action).toBe('union')
    // 远端骨架 x/R1/same + 本地独有的 L1
    expect(r.content).toBe(j('x', 'R1', 'same', 'L1'))
    expect(r.detail?.merged).toBe(4)
  })

  it('同一行出现两次是合法的，按多重集算不丢', () => {
    const { merged, appended } = unionLines(['a', 'a'], ['a'])
    expect(merged).toEqual(['a', 'a'])
    expect(appended).toBe(0)
  })

  describe('有 base 时的三方判定（不靠前缀猜）', () => {
    it('本地未动 → 取远端', () => {
      const r = mergeFile({ path: 'a.ndjson', local: j('x'), remote: j('x', 'y'), base: j('x') })
      expect(r.action).toBe('take-remote')
    })

    it('远端未动 → 推本地', () => {
      const r = mergeFile({ path: 'a.ndjson', local: j('x', 'z'), remote: j('x'), base: j('x') })
      expect(r.action).toBe('keep-local')
    })

    it('两侧都动过 → 落到行并集', () => {
      const r = mergeFile({ path: 'a.ndjson', local: j('x', 'L'), remote: j('x', 'R'), base: j('x') })
      expect(r.action).toBe('union')
    })
  })

  describe('必须停下来的情况', () => {
    it('两侧都改过、且某侧有压实痕迹 → blocked（行拼接对此不成立）', () => {
      const local = `${row('c1')}\n${row('c2', ',"__mikiSeq":9')}\n`
      const remote = `${row('c1')}\n${row('c3')}\n`
      const r = mergeFile({ path: 'cards/d.ndjson', local, remote })
      expect(r.action).toBe('blocked')
      expect(r.content).toBeNull()
      expect(r.reason).toContain('压实')
    })

    it('非 NDJSON 两侧都改过 → blocked（JSON 不能按行拼）', () => {
      const r = mergeFile({ path: 'decks.json', local: '[{"id":"a"}]', remote: '[{"id":"b"}]' })
      expect(r.action).toBe('blocked')
      expect(r.reason).toContain('JSON')
    })

    it('合出来的行如果没法解析 → blocked（宁可不合）', () => {
      const remote = '{"a":1}\nnot json\n'
      const local = '{"a":2}\n{"b":3}\n'
      // not json 与两侧都对不上 → 会被并进来，validateUnion 应当拒绝
      const bad = [...linesOf(remote, 'p'), ...linesOf(local, 'p')]
      const v = validateUnion(linesOf(remote, 'p'), linesOf(local, 'p'), bad)
      expect(v.ok).toBe(false)
      expect(v.why).toContain('无法解析')
    })
  })

  it('校验失败时不产出内容（调用方据此停止同步）', () => {
    const remoteLines = ['{"a":1}']
    const localLines = ['{"b":2}']
    // 故意漏掉一行，模拟"合并实现有 bug"
    expect(validateUnion(remoteLines, localLines, ['{"a":1}']).ok).toBe(false)
  })
})

describe('summarize', () => {
  it('按动作分类，union 同时出现在推与拉两侧', () => {
    const results = [
      mergeFile({ path: 'a.ndjson', local: j('x'), remote: j('x') }),
      mergeFile({ path: 'b.ndjson', local: j('x', 'L'), remote: j('x') }),
      mergeFile({ path: 'c.ndjson', local: null, remote: j('x') }),
      mergeFile({ path: 'd.ndjson', local: j('x', 'L'), remote: j('x', 'R') })
    ]
    const s = summarize(results)
    expect(s.unchanged.map((r) => r.path)).toEqual(['a.ndjson'])
    expect(s.push.map((r) => r.path)).toEqual(['b.ndjson', 'd.ndjson'])
    expect(s.pull.map((r) => r.path)).toEqual(['c.ndjson', 'd.ndjson'])
    expect(s.blocked).toEqual([])
  })
})
