// 数值草稿 hook 单测（Settings 页）：拖动过程只改草稿、停顿才 commit、flush 立即落盘、
// 回声不回写、卸载补落、外部真变化同步草稿。hook 依赖 React 调度与 DOM，需 jsdom 环境。
// @vitest-environment jsdom
import { createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNumericDraft } from '../settings/numericDraft'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** 测试支架：把 hook 的返回值透传到 ref，configValue 变化用重渲染驱动 */
function Harness({
  configValue,
  commit,
  delay,
  apiRef
}: {
  configValue: number
  commit: (v: number) => void
  delay?: number
  apiRef: React.MutableRefObject<ReturnType<typeof useNumericDraft> | null>
}) {
  const api = useNumericDraft(configValue, commit, delay)
  apiRef.current = api
  return null
}

async function mount(configValue: number, commit: (v: number) => void, delay = 400) {
  const apiRef = createRef<ReturnType<typeof useNumericDraft>>() as React.MutableRefObject<ReturnType<
    typeof useNumericDraft
  > | null>
  await act(async () => {
    root.render(<Harness configValue={configValue} commit={commit} delay={delay} apiRef={apiRef} />)
  })
  return {
    apiRef,
    async rerender(next: number) {
      await act(async () => {
        root.render(<Harness configValue={next} commit={commit} delay={delay} apiRef={apiRef} />)
      })
    },
    async unmount() {
      await act(async () => {
        root.unmount()
      })
    }
  }
}

describe('useNumericDraft（设置页数值草稿）', () => {
  it('拖动过程（连续 set）只改草稿，停满 delay 才 commit 一次最终值', async () => {
    const commit = vi.fn()
    const h = await mount(16, commit, 400)
    await act(async () => {
      h.apiRef.current!.set(17)
    })
    vi.advanceTimersByTime(200)
    await act(async () => {
      h.apiRef.current!.set(18)
    })
    vi.advanceTimersByTime(200)
    expect(commit).not.toHaveBeenCalled() // 连续拖动期间不落盘
    expect(h.apiRef.current!.draft).toBe(18)
    vi.advanceTimersByTime(200)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith(18)
    await h.unmount()
  })

  it('flush（松手/失焦）立即 commit，不等防抖', async () => {
    const commit = vi.fn()
    const h = await mount(16, commit, 400)
    await act(async () => {
      h.apiRef.current!.set(20)
    })
    await act(async () => {
      h.apiRef.current!.flush()
    })
    expect(commit).toHaveBeenCalledWith(20)
    // 已 commit 的值不会被计时器再写一次
    vi.advanceTimersByTime(500)
    expect(commit).toHaveBeenCalledTimes(1)
    await h.unmount()
  })

  it('自家 commit 的回声（configValue === 上次发送值）不回写草稿', async () => {
    const commit = vi.fn()
    const h = await mount(16, commit, 10)
    await act(async () => {
      h.apiRef.current!.set(22)
    })
    vi.advanceTimersByTime(20)
    expect(commit).toHaveBeenCalledWith(22)
    // reload 回读 configValue=22，是自家回声：草稿不应被重置（拖动中不被旧值拉回）
    await h.rerender(22)
    expect(h.apiRef.current!.draft).toBe(22)
    await h.unmount()
  })

  it('外部真变化（非回声）同步草稿', async () => {
    const commit = vi.fn()
    const h = await mount(16, commit)
    await h.rerender(24) // 外部改了配置（比如另一个入口）
    expect(h.apiRef.current!.draft).toBe(24)
    await h.unmount()
  })

  it('回声只消费一次：同样的值再来第二次视为外部真变化', async () => {
    const commit = vi.fn()
    const h = await mount(16, commit, 10)
    await act(async () => {
      h.apiRef.current!.set(22)
    })
    vi.advanceTimersByTime(20)
    await h.rerender(22) // 第一次 22 = 回声，消费掉
    await h.rerender(22) // 第二次 22 已不是回声 → 同步（值相同，草稿不变但路径走通）
    expect(h.apiRef.current!.draft).toBe(22)
    await h.unmount()
  })

  it('带着未落盘草稿卸载：补一次 commit', async () => {
    const commit = vi.fn()
    const h = await mount(16, commit, 400)
    await act(async () => {
      h.apiRef.current!.set(28)
    })
    await h.unmount()
    expect(commit).toHaveBeenCalledWith(28)
  })

  it('卸载时无在途计时：不产生多余 commit', async () => {
    const commit = vi.fn()
    const h = await mount(16, commit, 400)
    await h.unmount()
    expect(commit).not.toHaveBeenCalled()
  })
})
