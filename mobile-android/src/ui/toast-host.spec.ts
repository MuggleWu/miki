// 提示条（toast）怎么显示在弹层之上（纯函数单测）。
//
// 为什么值得单测：新增卡片保存后不再关抽屉（连续录入），而弹层是原生 `<dialog>.showModal()`——
// 它把对话框提到顶层，挂在 .app 下的提示条连同文字一起被遮罩盖住。真机上看到的现象是
// "存完了什么都没提示"，很容易被当成「没存上」再存一遍。
//
// 这条路径上踩过一个坑，值得写进注释：第一版是把提示条的 DOM 挪进当前打开的 dialog
// （视觉上确实好了），但 React 不认账——节点被搬走之后 React 仍按原位置删它，
// 卸载提示时抛 `NotFoundError: Failed to execute 'removeChild' on 'Node'`，整棵树崩掉。
// 现在改成 popover：节点一动不动，进顶层由浏览器负责。下面的用例把这两件事都钉住。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { syncToastPopover, type ToastLike } from './toast-host'

/** 只实现 syncToastPopover 用到的那几个方法的替身 */
class FakeToast implements ToastLike {
  open = false
  showCalls = 0
  hideCalls = 0
  /** 模拟不支持 popover 的老引擎（没有这两个方法） */
  constructor(private readonly supports = true) {
    if (!supports) {
      // 显式删掉：可选方法缺席就是老引擎的样子
      delete (this as { showPopover?: unknown }).showPopover
      delete (this as { hidePopover?: unknown }).hidePopover
    }
  }

  matches(sel: string): boolean {
    return sel === ':popover-open' && this.open
  }

  showPopover(): void {
    if (this.open) throw new Error('InvalidStateError')
    this.open = true
    this.showCalls++
  }

  hidePopover(): void {
    if (!this.open) throw new Error('InvalidStateError')
    this.open = false
    this.hideCalls++
  }
}

describe('syncToastPopover：提示条进顶层', () => {
  it('提示出现 → 进顶层（弹层开着时才看得见）', () => {
    const t = new FakeToast()
    syncToastPopover(t, true)
    expect(t.open).toBe(true)
    expect(t.showCalls).toBe(1)
  })

  it('提示消失 → 退出顶层，不再占着屏幕', () => {
    const t = new FakeToast()
    syncToastPopover(t, true)
    syncToastPopover(t, false)
    expect(t.open).toBe(false)
    expect(t.hideCalls).toBe(1)
  })

  it('重复同步不重复调用（每次渲染都会跑，这里必须幂等）', () => {
    const t = new FakeToast()
    syncToastPopover(t, true)
    syncToastPopover(t, true)
    syncToastPopover(t, false)
    syncToastPopover(t, false)
    expect(t.showCalls).toBe(1)
    expect(t.hideCalls).toBe(1)
  })

  it('浏览器拒绝（已经在顶层/正在关闭）时不往外抛', () => {
    // 真实浏览器在边界状态下会抛 InvalidStateError，调用方是渲染期 effect，不能让它炸
    const t = new FakeToast()
    t.open = true
    expect(() => syncToastPopover(t, false)).not.toThrow()
    expect(t.open).toBe(false)
  })

  it('老引擎（没有 popover API）静默降级，不报错', () => {
    const t = new FakeToast(false)
    expect(() => syncToastPopover(t, true)).not.toThrow()
    expect(() => syncToastPopover(t, false)).not.toThrow()
  })

  it('没有提示条元素时什么都不做', () => {
    expect(() => syncToastPopover(null, true)).not.toThrow()
  })
})

describe('提示条不能靠搬 DOM 进顶层（那条路会把 React 弄崩）', () => {
  const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  it('App 里不出现 append/insertBefore 之类的节点搬运动作', () => {
    expect(app).not.toMatch(/\.append\(|insertBefore|\.appendChild\(/)
  })

  it('提示条带 popover="manual"（借展开写法绕开 @types/react 的缺失声明），且由 syncToastPopover 控制显隐', () => {
    expect(app).toMatch(/className="toast" \{\.\.\.\{ popover: 'manual' \}\}/)
    expect(app).toMatch(/syncToastPopover\(toastRef\.current/)
  })
})
