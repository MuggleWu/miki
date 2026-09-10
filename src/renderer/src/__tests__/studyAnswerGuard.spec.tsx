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
const CARD_C: Card = { ...CARD_A, id: 'card-c', front: '正面 C' }

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
function key(k: string, meta = false) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: k, metaKey: meta, bubbles: true, cancelable: true }))
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

// 答题耗时是「题目上屏 → 按下评级」的墙钟差值，待机/合盖/去吃饭都会算进去。真实数据里
// 最大一条 29.9 分钟，会让统计页的「平均单卡答题耗时」整个失真。这里钉住封顶行为。
// 「取卡」与「改变当前卡的写操作」是两条互不知情的异步链：前者有 studySeq 守卫、后者有
// answeringRef 闸门，但谁也管不到对方。若一条 getStudy 在写操作之前发起、之后才回包，
// 它带回的是「已经答完的同一张卡」的旧快照——界面被盖回去，且闸门已释放，同一张卡会被
// 答第二次，review-log 追两条 answer 事件。这组测试钉住「写操作发出即作废在途重取」。
describe('取卡与写操作交错：在途重取不得覆盖写操作结果', () => {
  /** 手动放行的 getStudy 响应（模拟外部变更触发的取卡，响应慢到写操作之后才回来） */
  function slowGetStudy() {
    const d = deferred<unknown>()
    const api = (window as unknown as { miki: { getStudy: ReturnType<typeof vi.fn> } }).miki
    api.getStudy.mockImplementationOnce(() => d.promise)
    return d
  }

  it('评级在途重取之后回包：旧快照被丢弃，且不会把已答完的卡放回去', async () => {
    await mountStudy()
    await showAnswer()

    // 1. 外部变更触发重取，响应挂住（带的是 card-a 的旧快照）
    const slow = slowGetStudy()
    await act(async () => {
      useApp.setState({ dataEpoch: 1 })
    })

    // 2. 用户评级：立即回包，界面推进到 card-b
    answer.mockImplementation(async () => ({ ...payload(CARD_B), answeredCardId: 'card-a' }))
    await act(async () => {
      key('3')
    })
    expect(useApp.getState().studyCurrentCardId).toBe('card-b')

    // 3. 挂住的取卡响应现在才到（旧快照 card-a）
    await act(async () => {
      slow.resolve(payload(CARD_A))
      await Promise.resolve()
    })
    // 关键断言：当前卡仍是 card-b，未被旧快照盖回 card-a
    expect(useApp.getState().studyCurrentCardId).toBe('card-b')

    // 4. 再评一次：必须是 card-b，不能又出现 card-a（否则同卡答两次）
    await showAnswer()
    await act(async () => {
      key('4')
    })
    expect(answer).toHaveBeenCalledTimes(2)
    expect(answer).toHaveBeenLastCalledWith('card-b', 4, expect.any(Number))
  })

  it('撤销之后新发起的重取仍然生效（它是权威最新状态，不该被压制）', async () => {
    const api = (window as unknown as { miki: Record<string, unknown> }).miki as {
      getStudy: ReturnType<typeof vi.fn>
      undo: () => Promise<unknown>
    }
    await mountStudy()
    await showAnswer()
    answer.mockImplementation(async () => ({ ...payload(CARD_B), answeredCardId: 'card-a' }))
    await act(async () => {
      key('3')
    })
    expect(useApp.getState().studyCurrentCardId).toBe('card-b')

    // 撤销发出（挂住）
    const undoD = deferred<{ restoredCardId: string; card: Card; remaining: number; todayCount: number }>()
    api.undo = () => undoD.promise
    await act(async () => {
      key('z', true) // ⌘Z
    })

    // 撤销在途时用户完成一次编辑 → 重取发出（在撤销之后发起 → 代次更新）
    const slow = deferred<unknown>()
    api.getStudy.mockImplementationOnce(() => slow.promise)
    await act(async () => {
      useApp.setState({ dataEpoch: 1 })
    })

    await act(async () => {
      undoD.resolve({ restoredCardId: 'card-a', card: CARD_A, remaining: 1, todayCount: 0 })
      await Promise.resolve()
    })
    // 撤销先回包 → 暂时回到 card-a
    expect(useApp.getState().studyCurrentCardId).toBe('card-a')

    // 后发起的重取回包：它是「读主进程最新状态」，应生效（否则界面会停留在已失效的 card-a）
    await act(async () => {
      slow.resolve(payload(CARD_C))
      await Promise.resolve()
    })
    expect(useApp.getState().studyCurrentCardId).toBe('card-c')
  })

  it('撤销之前发起的重取，回包时必须被丢弃（不得盖回撤销结果）', async () => {
    const api = (window as unknown as { miki: Record<string, unknown> }).miki as {
      getStudy: ReturnType<typeof vi.fn>
    }
    await mountStudy()
    await showAnswer()
    answer.mockImplementation(async () => ({ ...payload(CARD_B), answeredCardId: 'card-a' }))
    await act(async () => {
      key('3')
    })
    expect(useApp.getState().studyCurrentCardId).toBe('card-b')

    // 1. 重取先发起并挂住（此时界面还停在 card-b）
    const slow = deferred<unknown>()
    api.getStudy.mockImplementationOnce(() => slow.promise)
    await act(async () => {
      useApp.setState({ dataEpoch: 1 })
    })

    // 2. 用户按 ⌘Z：撤销结果随回包生效
    const undoD = deferred<{ restoredCardId: string; card: Card; remaining: number; todayCount: number }>()
    ;(api as unknown as { undo: () => Promise<unknown> }).undo = () => undoD.promise
    await act(async () => {
      key('z', true)
    })
    await act(async () => {
      undoD.resolve({ restoredCardId: 'card-a', card: CARD_A, remaining: 1, todayCount: 0 })
      await Promise.resolve()
    })
    expect(useApp.getState().studyCurrentCardId).toBe('card-a')

    // 3. 那条早于撤销发起的重取现在才回包：必须被丢弃，否则界面被旧快照盖成 card-c
    await act(async () => {
      slow.resolve(payload(CARD_C))
      await Promise.resolve()
    })
    expect(useApp.getState().studyCurrentCardId).toBe('card-a')
  })
})

/** 5 分钟。这里写死而不是 import：模块级常量在测试期经 vi.mock 处理后读不到，
 * 而且把它当契约断言更合适——改上限就得同时改这里，属于有意的摩擦 */
const CAP_MS = 300_000

describe('答题耗时封顶', () => {
  it('待机很久后作答，耗时被截到 MAX_ANSWER_MS 而不是墙钟时长', async () => {
    await mountStudy()
    await showAnswer()
    // 题目上屏后过了 2 小时（模拟合盖/离开）
    const real = Date.now
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => real() + 2 * 60 * 60 * 1000)
    try {
      await act(async () => {
        key('3')
      })
    } finally {
      spy.mockRestore() // 只撤这一个桩；restoreAllMocks 会连 answer 的调用记录一起清掉
    }
    expect(answer).toHaveBeenCalledTimes(1)
    const [, , durationMs] = answer.mock.calls[0] as [string, number, number]
    expect(durationMs).toBe(CAP_MS)
  })

  it('正常作答（几秒）如实记录，不被封顶影响', async () => {
    await mountStudy()
    await showAnswer()
    const real = Date.now
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => real() + 4000)
    try {
      await act(async () => {
        key('3')
      })
    } finally {
      spy.mockRestore()
    }
    const [, , durationMs] = answer.mock.calls[0] as [string, number, number]
    expect(durationMs).toBeGreaterThanOrEqual(4000)
    expect(durationMs).toBeLessThan(CAP_MS)
  })
})
