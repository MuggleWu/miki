import { describe, expect, it } from 'vitest'
import { createSeqGuard } from '../staleGuard'

describe('createSeqGuard（异步竞态防护）', () => {
  it('最新序号放行，被更新请求超越的旧序号拦截', () => {
    const g = createSeqGuard()
    const a = g.next()
    expect(g.isLatest(a)).toBe(true)
    const b = g.next()
    expect(g.isLatest(a)).toBe(false) // 旧响应晚到
    expect(g.isLatest(b)).toBe(true)
  })

  it('空守卫不误拦', () => {
    const g = createSeqGuard()
    expect(g.isLatest(0)).toBe(false) // 从未发起过请求
    const s = g.next()
    expect(g.isLatest(s)).toBe(true)
  })
})
