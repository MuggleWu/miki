// 防抖落盘（从 Browser.tsx 收敛出的纯逻辑）：连续变化（键盘/点击快扫）期间
// 不逐次写盘，停顿 debounceMs 或 dispose（卸载/离开页面）才写最终值一次。
// 不依赖 React / DOM，保存回调与值类型由调用方注入。
export interface DebouncedPersist<T> {
  /** 记录一次变化：重置防抖计时 */
  push(value: T): void
  /** 立即落盘（若计时在途），不等防抖；无在途计时是 no-op */
  flushNow(): void
  /** 卸载清理：在途则立即落盘；无在途计时是 no-op */
  dispose(): void
  /** 测试辅助：当前是否有在途计时 */
  pending(): boolean
}

export function createDebouncedPersist<T>(save: (value: T) => void, debounceMs = 600): DebouncedPersist<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let latest: T | undefined
  let hasValue = false

  const fire = (): void => {
    timer = null
    if (hasValue) {
      hasValue = false
      save(latest as T)
    }
  }

  return {
    push(value) {
      latest = value
      hasValue = true
      if (timer) clearTimeout(timer)
      timer = setTimeout(fire, debounceMs)
    },
    flushNow() {
      if (timer) {
        clearTimeout(timer)
        fire()
      }
    },
    dispose() {
      if (timer) {
        clearTimeout(timer)
        fire()
      }
    },
    pending() {
      return timer !== null
    }
  }
}
