// 防抖落盘单测：连续 push 不逐次写、停顿后写最终值、flushNow/dispose 立即补写、重复 dispose 安全
import { describe, expect, it, vi } from 'vitest'
import { createDebouncedPersist } from '../browser/debouncedPersist'

describe('createDebouncedPersist（选中态防抖落盘）', () => {
  it('连续 push 只在停满 debounceMs 后写一次最终值', () => {
    vi.useFakeTimers()
    const save = vi.fn()
    const p = createDebouncedPersist<{ id: string }>(save, 600)

    p.push({ id: 'a' })
    vi.advanceTimersByTime(300)
    p.push({ id: 'b' })
    vi.advanceTimersByTime(300)
    p.push({ id: 'c' })
    expect(save).not.toHaveBeenCalled() // 连续快扫期间一次都不写
    vi.advanceTimersByTime(600)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({ id: 'c' }) // 只写最终值
    expect(p.pending()).toBe(false)
    vi.useRealTimers()
  })

  it('flushNow 立即补写在途值，不等防抖计时', () => {
    vi.useFakeTimers()
    const save = vi.fn()
    const p = createDebouncedPersist<{ id: string }>(save, 600)
    p.push({ id: 'a' })
    p.flushNow()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({ id: 'a' })
    // 已落盘的值不会被计时器再写一次
    vi.advanceTimersByTime(600)
    expect(save).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('无在途计时 flushNow / dispose 都是安全 no-op', () => {
    const save = vi.fn()
    const p = createDebouncedPersist<{ id: string }>(save, 600)
    p.flushNow()
    p.dispose()
    expect(save).not.toHaveBeenCalled()
  })

  it('dispose 在卸载时补写最终值（组件离开页面语义）', () => {
    vi.useFakeTimers()
    const save = vi.fn()
    const p = createDebouncedPersist<{ id: string }>(save, 600)
    p.push({ id: 'x' })
    p.dispose()
    expect(save).toHaveBeenCalledWith({ id: 'x' })
    vi.advanceTimersByTime(600)
    expect(save).toHaveBeenCalledTimes(1) // 卸载后计时器不会再触发
    vi.useRealTimers()
  })

  it('dispose 后再次 dispose / flushNow 不重复写', () => {
    const save = vi.fn()
    const p = createDebouncedPersist<{ id: string }>(save, 600)
    p.push({ id: 'x' })
    p.dispose()
    p.dispose()
    p.flushNow()
    expect(save).toHaveBeenCalledTimes(1)
  })
})
