// 手势结束后的"吞一次点击"。
//
// 为什么需要：触摸手势（上滑删除、抽屉拖动）松手后，浏览器往往还会给落点上补发一次 click。
// 不吞掉它，上滑删完卡会顺手把下一张的答案翻出来。
//
// 为什么必须能被"新的触摸"解除：第一版用的是一个布尔标志，只在真的来了点击时清掉。
// 手势没补发 click 时这个标志就一直挂着，于是**用户下一次完整点按被吞掉**——真机上表现为
// "删完卡之后有一段时间点卡面没反应"。所以：新触摸一律先解除，吞掉状态只在手势刚结束的
// 那一小段时间内有效。

export interface ClickSwallower {
  /** 手势结束：接下来这个时间窗内到达的 click 吞掉一次 */
  suppress(now: number, ms?: number): void
  /** 新的触摸开始了：之前挂着的吞掉状态立即作废 */
  release(): void
  /** 这一次点击要不要吞掉（吞掉的同时自动解除） */
  shouldSwallow(now: number): boolean
}

/** 默认窗口：浏览器在 touchend 之后补发的 click 通常在同一帧，长一点的兜底也够用 */
export const SWALLOW_CLICK_MS = 350

export function createClickSwallower(): ClickSwallower {
  let until = -1
  return {
    suppress(now, ms = SWALLOW_CLICK_MS) {
      until = now + ms
    },
    release() {
      until = -1
    },
    shouldSwallow(now) {
      if (until < 0 || now >= until) return false
      // 只吞一次：补发的 click 只会来一下，多吞就是吞用户的下一次点按
      until = -1
      return true
    }
  }
}
