// 编辑弹窗的 lost update 防护：弹窗从打开到提交之间隔着用户思考时间，期间主窗口/卡片库
// 可能已经改过同一张卡。没有版本校验时，弹窗会带着打开时的旧内容整体覆盖，那次改动被静默
// 丢弃。这里钉住「检测到冲突时不写盘、明确告知用户、且不关窗丢内容」。
// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CardForm } from '../components/AddEditDialog'
import { useApp } from '../store'
import type { Card, DeckInfo } from '../../../shared/types'

const DECK = { id: 'deck-1', name: '牌组一', counts: { total: 0, due: 0, new: 0 } } as unknown as DeckInfo
const CARD = {
  id: 'card-1',
  front: '打开时的正面',
  back: '打开时的反面',
  deckId: 'deck-1',
  createdAt: 1000,
  updatedAt: 2000,
  deletedAt: null,
  suspended: false
} as unknown as Card

let host: HTMLDivElement
let root: Root
let miki: Record<string, ReturnType<typeof vi.fn>>
let onSubmitted: ReturnType<typeof vi.fn>

/** 冲突场景：getCard 返回打开时的快照，updateCardChecked 报冲突（期间被别处改过） */
function installApi(conflict: { card: Card } | null) {
  miki = {
    addCard: vi.fn(async () => ({ id: 'new-card' })),
    updateCard: vi.fn(async () => CARD),
    updateCardChecked: vi.fn(async () =>
      conflict ? { status: 'conflict', card: conflict.card } : { status: 'ok', card: CARD }
    ),
    getCard: vi.fn(async () => CARD),
    loadWorkspace: vi.fn(async () => ({ decks: [DECK], todayCount: 0, totalCount: 0, config: null })),
    queryCards: vi.fn(async () => ({ rows: [], total: 0 })),
    getStats: vi.fn(async () => null)
  }
  ;(window as unknown as { miki: unknown }).miki = miki
}

async function mount() {
  onSubmitted = vi.fn()
  await act(async () => {
    root.render(<CardForm mode="edit" deckId="deck-1" cardId="card-1" onSubmitted={onSubmitted} />)
  })
  // 等 getCard 回包填表
  await act(async () => {
    await Promise.resolve()
  })
}

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
  useApp.setState({ decks: [DECK], config: null })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  host.remove()
  vi.restoreAllMocks()
})

describe('编辑弹窗的乐观锁提交', () => {
  it('提交时带上打开时读到的 updatedAt 作为版本基准', async () => {
    installApi(null)
    await mount()
    await typeFront('我改的正面')
    await act(async () => {
      submitButton().click()
      await Promise.resolve()
    })
    expect(miki.updateCardChecked).toHaveBeenCalledWith('card-1', { front: '我改的正面', back: '打开时的反面' }, 2000)
    expect(onSubmitted).toHaveBeenCalledWith('edit')
  })

  it('冲突时：不写盘、给出明确提示、不关窗、内容留在表单里', async () => {
    installApi({ card: { ...CARD, front: '别处改的正面', updatedAt: 9999 } })
    await mount()
    await typeFront('我改的正面')
    await act(async () => {
      submitButton().click()
      await Promise.resolve()
      await Promise.resolve()
    })
    // 关键：没有发生「静默覆盖」——普通 updateCard 绝不能被调到
    expect(miki.updateCard).not.toHaveBeenCalled()
    // 用户被告知，且能看见对方那一版
    expect(host.textContent).toContain('已被改动')
    expect(host.textContent).toContain('载入对方的最新内容')
    // 弹窗不能关：关了就等于把用户刚输入的内容丢了
    expect(onSubmitted).not.toHaveBeenCalled()
    const el = host.querySelector('textarea') as HTMLTextAreaElement
    expect(el.value).toBe('我改的正面')
  })

  it('点「载入对方的最新内容」后表单换成最新版，再次提交即可保存', async () => {
    installApi({ card: { ...CARD, front: '别处改的正面', updatedAt: 9999 } })
    await mount()
    await typeFront('我改的正面')
    await act(async () => {
      submitButton().click()
      await Promise.resolve()
      await Promise.resolve()
    })
    const adopt = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('载入对方的最新内容'))
    expect(adopt).toBeTruthy()
    // 载入后 getCard 返回最新版
    miki.getCard.mockImplementation(async () => ({ ...CARD, front: '别处改的正面', updatedAt: 9999 }))
    await act(async () => {
      ;(adopt as HTMLButtonElement).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    const el = host.querySelector('textarea') as HTMLTextAreaElement
    expect(el.value).toBe('别处改的正面')
    expect(host.textContent).not.toContain('已被改动') // 冲突提示已清
  })
})
