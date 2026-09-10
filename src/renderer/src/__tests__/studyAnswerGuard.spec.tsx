// 学习页评级在途闸门单测：空格/1-4 在 IPC 往返期间连按，只能产生一条 answer 调用。
// 这是数据完整性级别的约束——重复 answer 会在 review-log 追两条事件，永久污染
// reps/lapses 与 FSRS 的 shortTerm 分支，且撤销只能退一步。
// 组件依赖 React 调度与 DOM，需 jsdom 环境。
// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Study } from '../study/Study'
import { useApp } from '../store'
import type { Card, MikiConfig, StudyPayload } from '../../../shared/types'

const CARD_A: Card = {
  id: 'card-a',
  deckId: 'deck-1',
  front: '正面 A',
  back: '反面 A',
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  suspended: false,
  fsrs: null,
  reps: 0,
  lapses: 0
}

const CARD_B: Card = { ...CARD_A, id: 'card-b', front: '正面 B' }

function payload(card: Card | null): StudyPayload {
  return { card, remaining: 1, todayCount: 0 }
}

/** 取用部署时 config 的真实形状（只填本测试走到的部分） */
const CONFIG = { study: { fontFamily: '', fontSize: 16 }, theme: 'light' } as unknown as MikiConfig

/** 手动放行的 Promise：模拟 IPC 在途窗口 */
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

let host: HTMLDivElement
let root: Root
let answer: ReturnType<typeof vi.fn>

function installApi() {
  const api = {
    getStudy: vi.fn(async () => payload(CARD_A)),
    answer,
    previewIntervals: vi.fn(async () => [0, 0, 0, 0]),
    onWorkspaceChanged: vi.fn(() => () => {}),
    onCardDialogVisibility: vi.fn(() => () => {}),
    onCardsChanged: vi.fn(() => () => {}),
    onCardDialogPayload: vi.fn(() => () => {})
  }
  ;(window as unknown as { miki: unknown }).miki = api
  return api
}

/** 派发真实 window keydown（Study 在 window 上挂监听） */
function key(k: string) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
}

/** 挂载并等首张卡装载完成（getStudy 的 await 链走完） */
async function mountStudy() {
  await act(async () => {
    root.render(<Study />)
  })
  await act(async () => {
    await Promise.resolve()
  })
}

/** 进入答案相位 */
async function showAnswer() {
  await act(async () => {
    key(' ')
  })
}

function rateButtons(): HTMLButtonElement[] {
  return [...host.querySelectorAll('.rate-card')] as HTMLButtonElement[]
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  answer = vi.fn(() => new Promise<never>(() => {})) // 默认永不 resolve：一直保持在途
  installApi()
  useApp.setState({
    decks: [],
    config: CONFIG,
    studyDeckId: 'deck-1',
    selectedDeckId: 'deck-1',
    tab: 'study',
    contentEpoch: 0,
    dataEpoch: 0,
    studyCurrentCardId: null
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  host.remove()
  vi.restoreAllMocks()
})

describe('学习页评级在途闸门', () => {
  it('答案相位连按两次数字键，只发出一次 answer', async () => {
    await mountStudy()
    await showAnswer()
    // 同一 tick 连按两次「良好」——在途未回包，payload 仍是同一张卡的旧快照
    await act(async () => {
      key('3')
      key('3')
    })
    expect(answer).toHaveBeenCalledTimes(1)
    expect(answer).toHaveBeenCalledWith('card-a', 3, expect.any(Number))
  })

  it('答案相位连按空格（空格=评良好）同样只发出一次', async () => {
    await mountStudy()
    await showAnswer()
    await act(async () => {
      key(' ')
      key(' ')
    })
    expect(answer).toHaveBeenCalledTimes(1)
    expect(answer).toHaveBeenCalledWith('card-a', 3, expect.any(Number))
  })

  it('在途期间四个评级键混合连按，仍只发出首次那一次', async () => {
    await mountStudy()
    await showAnswer()
    await act(async () => {
      key('1')
      key('2')
      key('4')
    })
    expect(answer).toHaveBeenCalledTimes(1)
    expect(answer).toHaveBeenCalledWith('card-a', 1, expect.any(Number))
  })

  it('在途期间评级按钮为禁用态（视觉/点击双重反馈）', async () => {
    await mountStudy()
    await showAnswer()
    await act(async () => {
      key('3')
    })
    const btns = rateButtons()
    expect(btns).toHaveLength(4)
    expect(btns.every((b) => b.disabled)).toBe(true)
  })

  it('回包后闸门释放：可正常评下一张', async () => {
    const first = deferred<StudyPayload & { answeredCardId: string }>()
    answer.mockImplementationOnce(() => first.promise)
    await mountStudy()
    await showAnswer()
    await act(async () => {
      key('3')
    })
    expect(answer).toHaveBeenCalledTimes(1)

    // 放行首次请求：主进程回包并把队列推进到 card-b
    answer.mockImplementation(async () => ({ ...payload(CARD_B), answeredCardId: 'card-b' }))
    await act(async () => {
      first.resolve({ ...payload(CARD_B), answeredCardId: 'card-a' })
      await Promise.resolve()
    })

    const btns = rateButtons()
    expect(btns.every((b) => !b.disabled)).toBe(true)

    await showAnswer()
    await act(async () => {
      key('4')
    })
    expect(answer).toHaveBeenCalledTimes(2)
    expect(answer).toHaveBeenLastCalledWith('card-b', 4, expect.any(Number))
  })
})
