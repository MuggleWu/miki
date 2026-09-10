// 卡片表单提交的重入防护：addCard/updateCard 是异步的，await 期间按钮仍可点、⌘Enter
// 仍可再次触发——双击（或快捷键连按）会建出两张一模一样的卡，用户只会看到「牌组里
// 莫名其妙多了一张」。这里钉住「同一份表单的一次提交只产生一次写入」。
// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CardForm } from '../components/AddEditDialog'
import { useApp } from '../store'
import type { DeckInfo } from '../../../shared/types'

const DECK = { id: 'deck-1', name: '牌组一', counts: { total: 0, due: 0, new: 0 } } as unknown as DeckInfo

let host: HTMLDivElement
let root: Root
let miki: Record<string, ReturnType<typeof vi.fn>>

/** addCard 延迟返回，模拟真实 IPC 的在途窗口 */
function installApi(delayMs = 20) {
  miki = {
    addCard: vi.fn(() => new Promise((r) => setTimeout(() => r({ id: 'new-card' }), delayMs))),
    updateCard: vi.fn(async () => ({ id: 'card-1' })),
    getCard: vi.fn(async () => null),
    // reload() 会解构这四个字段，桩必须给全（否则 store 里抛、测试变噪声）
    loadWorkspace: vi.fn(async () => ({
      decks: [DECK],
      todayCount: 0,
      totalCount: 0,
      config: null
    })),
    queryCards: vi.fn(async () => ({ rows: [], total: 0 })),
    getStats: vi.fn(async () => null)
  }
  ;(window as unknown as { miki: unknown }).miki = miki
}

async function mount() {
  await act(async () => {
    root.render(<CardForm mode="add" deckId="deck-1" cardId={null} />)
  })
}

/** 在正面输入框写入内容 */
async function typeFront(text: string) {
  const el = host.querySelector('textarea') as HTMLTextAreaElement
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const submitButton = () => host.querySelector('button.primary') as HTMLButtonElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  installApi()
  useApp.setState({ decks: [DECK], config: null, tab: 'home' })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('卡片表单提交不会重复建卡', () => {
  it('连点两次提交只写一次', async () => {
    await mount()
    await typeFront('只有一张')
    await act(async () => {
      submitButton().click()
      submitButton().click() // 双击的第二下：落在第一次 await 的在途窗口内
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(miki.addCard).toHaveBeenCalledTimes(1)
  })

  it('连按三次 ⌘Enter 只写一次', async () => {
    await mount()
    await typeFront('快捷键连按')
    const form = host.firstElementChild as HTMLElement
    await act(async () => {
      for (let i = 0; i < 3; i++) {
        form.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
      }
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(miki.addCard).toHaveBeenCalledTimes(1)
  })

  it('写入失败：显示错误、不锁死表单、内容保留', async () => {
    await mount()
    await typeFront('先失败再成功')
    miki.addCard.mockRejectedValueOnce(new Error('boom'))
    await act(async () => {
      submitButton().click()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    // 错误可见（不是「点了没反应」），且输入内容没被清掉
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('保存失败')
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('先失败再成功')
    // 表单没被锁死：重试能成功
    await act(async () => {
      submitButton().click()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(miki.addCard).toHaveBeenCalledTimes(2)
  })

  it('空表单不产生写入', async () => {
    await mount()
    await act(async () => {
      submitButton().click()
    })
    expect(miki.addCard).not.toHaveBeenCalled()
  })
})
