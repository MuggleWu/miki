// 学习页 leech 自动暂停提示条：达阈值的「重来」会把这张卡自动暂停，它随即从队列与牌组计数里
// 消失。不提示的话，用户看到的是「答了一下，卡没了」——分不清是答完了、卡丢了还是被暂停了。
// 提示**常驻**（不是 toast）：它说的是"这张卡的状态变了"，不是"刚做了什么"的回执。
// 与移动端 .flash-warn 同一条文案与语气，两端不能各说一套。
// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Study } from '../study/Study'
import { useApp } from '../store'
import type { AnswerResult, Card, LeechSuspension, MikiConfig, StudyPayload, UndoResult } from '../../../shared/types'

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

/** 主进程回包的完整形状：答完的卡 + 是否触发 leech 暂停 */
function answered(card: Card | null, leechSuspended: LeechSuspension | null): AnswerResult {
  return { answeredCardId: CARD_A.id, leechSuspended, ...payload(card) }
}

const CONFIG = { study: { fontFamily: '', fontSize: 16 }, theme: 'light' } as unknown as MikiConfig

let host: HTMLDivElement
let root: Root
let answer: ReturnType<typeof vi.fn>
let undo: ReturnType<typeof vi.fn>

function installApi() {
  const api = {
    getStudy: vi.fn(async () => payload(CARD_A)),
    answer,
    undo,
    previewIntervals: vi.fn(async () => [0, 0, 0, 0]),
    onWorkspaceChanged: vi.fn(() => () => {}),
    onCardDialogVisibility: vi.fn(() => () => {}),
    onCardsChanged: vi.fn(() => () => {}),
    onCardDialogPayload: vi.fn(() => () => {})
  }
  ;(window as unknown as { miki: unknown }).miki = api
  return api
}

function key(k: string, meta = false) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: k, metaKey: meta, bubbles: true, cancelable: true }))
}

async function mountStudy() {
  await act(async () => {
    root.render(<Study />)
  })
  await act(async () => {
    await Promise.resolve()
  })
}

/** 显示答案并评「重来」（leech 的 lapses 只在 rating=1 时累加） */
async function rateAgain() {
  await act(async () => {
    key(' ')
  })
  await act(async () => {
    key('1')
  })
}

function noticeText(): string | null {
  return host.querySelector('.leech-banner span')?.textContent ?? null
}

function dismissButton(): HTMLButtonElement | null {
  return host.querySelector('.leech-banner .damage-dismiss')
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  answer = vi.fn(async () => answered(CARD_B, null))
  undo = vi.fn(async (): Promise<UndoResult> => ({ restoredCardId: null, card: null, remaining: 0, todayCount: 0 }))
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

describe('学习页 leech 自动暂停提示条', () => {
  it('未触发（leechSuspended=null）时不出现提示条', async () => {
    await mountStudy()
    await rateAgain()
    expect(answer).toHaveBeenCalledTimes(1)
    expect(noticeText()).toBeNull()
  })

  it('触发时提示条出现，且用主进程回报的 lapses 与 threshold 拼文案', async () => {
    answer.mockImplementationOnce(async () => answered(CARD_B, { lapses: 8, threshold: 8 }))
    await mountStudy()
    await rateAgain()
    const text = noticeText()
    expect(text).toContain('重来 8 次已达 leech 阈值')
    expect(text).toContain('已自动暂停')
    // 末尾必须写清"怎么找回来"，否则用户只知道卡没了
    expect(text).toContain('卡片库可解除')
  })

  it('用户把阈值调小后 lapses > threshold：提示里显示的是当时的真实两个数', async () => {
    answer.mockImplementationOnce(async () => answered(CARD_B, { lapses: 9, threshold: 3 }))
    await mountStudy()
    await rateAgain()
    expect(noticeText()).toContain('重来 9 次已达 leech 阈值')
  })

  it('「知道了」可以手动收掉', async () => {
    answer.mockImplementationOnce(async () => answered(CARD_B, { lapses: 8, threshold: 8 }))
    await mountStudy()
    await rateAgain()
    expect(noticeText()).not.toBeNull()
    await act(async () => {
      dismissButton()?.click()
    })
    expect(noticeText()).toBeNull()
  })

  it('撤销那次「重来」（连带解除自动暂停）后提示条立刻收掉', async () => {
    answer.mockImplementationOnce(async () => answered(CARD_B, { lapses: 8, threshold: 8 }))
    await mountStudy()
    await rateAgain()
    expect(noticeText()).not.toBeNull()

    undo.mockImplementationOnce(async () => ({
      restoredCardId: CARD_A.id,
      card: CARD_A,
      remaining: 1,
      todayCount: 0
    }))
    await act(async () => {
      key('z', true)
    })
    expect(undo).toHaveBeenCalledTimes(1)
    // 卡已经回到队列里了，屏幕上不能再留着"这张卡已自动暂停"
    expect(noticeText()).toBeNull()
  })

  it('下一次评级没触发暂停时，上一条提示被收掉（不留过期告警）', async () => {
    answer.mockImplementationOnce(async () => answered(CARD_B, { lapses: 8, threshold: 8 }))
    await mountStudy()
    await rateAgain()
    expect(noticeText()).not.toBeNull()
    // 第二张卡正常评级：回包 leechSuspended=null
    await rateAgain()
    expect(answer).toHaveBeenCalledTimes(2)
    expect(noticeText()).toBeNull()
  })
})
