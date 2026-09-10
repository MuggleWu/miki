// 渲染错误边界：页面组件抛错原本会让 React 卸载整棵树 → 窗口一片空白，无法继续操作。
// 这里钉住「错误被挡住 + 提示可见 + 重试能恢复 + 不影响兄弟节点」。
// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from '../components/ErrorBoundary'

let host: HTMLDivElement
let root: Root

/** 会在渲染时抛错的组件；带开关以便「重试后成功」 */
let shouldThrow = true
function Boom() {
  if (shouldThrow) throw new Error('渲染炸了')
  return <div className="ok">恢复正常</div>
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  shouldThrow = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  // React 会把边界捕获的错误再打一遍到 console.error；测试里静音以免刷屏
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('渲染错误边界', () => {
  it('子组件抛错：显示提示而不是空白', async () => {
    await act(async () => {
      root.render(
        <ErrorBoundary label="示例页出错了">
          <Boom />
        </ErrorBoundary>
      )
    })
    expect(host.textContent).toContain('示例页出错了')
    expect(host.textContent).toContain('渲染炸了')
    expect(host.querySelector('.error-boundary')).not.toBeNull()
  })

  it('点重试且子组件恢复正常：显示真实内容', async () => {
    await act(async () => {
      root.render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      )
    })
    expect(host.querySelector('.error-boundary')).not.toBeNull()

    shouldThrow = false
    await act(async () => {
      ;(host.querySelector('.error-boundary button') as HTMLButtonElement).click()
    })
    expect(host.querySelector('.error-boundary')).toBeNull()
    expect(host.querySelector('.ok')?.textContent).toBe('恢复正常')
  })

  it('onError 回调被调用，且回调自身抛错不会盖住原错误', async () => {
    const onError = vi.fn(() => {
      throw new Error('清理回调也炸了')
    })
    await act(async () => {
      root.render(
        <ErrorBoundary onError={onError}>
          <Boom />
        </ErrorBoundary>
      )
    })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('渲染炸了') // 仍是原始错误
  })

  it('边界之外的兄弟节点不受影响', async () => {
    await act(async () => {
      root.render(
        <div>
          <span className="keep">还在</span>
          <ErrorBoundary>
            <Boom />
          </ErrorBoundary>
        </div>
      )
    })
    expect(host.querySelector('.keep')?.textContent).toBe('还在')
    expect(host.querySelector('.error-boundary')).not.toBeNull()
  })
})
