// 热加载作废撤销栈的可见提示：撤销栈只存活于本会话，外部变更（git pull / 他机写入 / 直接
// 编辑文件）后主进程直接作废它。没有这条提示，用户在键盘上看到的是「按 ⌘Z 没反应」——
// 明明刚答了几张卡，撤销却无声失效。
// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MainApp from '../App'
import { useApp } from '../store'
import type { MikiConfig } from '../../../shared/types'

/** 取用部署时 config 的真实形状：reload 会读 config.browser 恢复卡片库选中态 */
const CONFIG = {
  study: { fontFamily: '', fontSize: 16 },
  theme: 'light',
  browser: { selectedDeckId: null, selectedCardId: null }
} as unknown as MikiConfig

let host: HTMLDivElement
let root: Root
/** 主进程推送撤销栈作废事件的订阅回调（测试里手动触发） */
let fireUndoDiscarded: (dropped: number) => void
/** 工作区热加载完成事件的订阅回调 */
let fireWorkspaceChanged: () => void

function installApi() {
  ;(window as unknown as { miki: unknown }).miki = {
    workspaceStatus: vi.fn(async () => ({ needsOnboarding: false, path: '/tmp/ws', name: 'ws', workspaces: [] })),
    loadWorkspace: vi.fn(async () => ({ decks: [], todayCount: 0, totalCount: 0, config: CONFIG })),
    dataDamageReport: vi.fn(async () => ({ damagedLines: 0, truncatedFiles: [], files: [] })),
    onWorkspaceChanged: vi.fn((cb: () => void) => {
      fireWorkspaceChanged = cb
      return () => {}
    }),
    onUndoDiscarded: vi.fn((cb: (d: number) => void) => {
      fireUndoDiscarded = cb
      return () => {}
    }),
    onCardsChanged: vi.fn(() => () => {}),
    onCardDialogVisibility: vi.fn(() => () => {}),
    onCardDialogPayload: vi.fn(() => () => {})
  }
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  installApi()
  useApp.setState({ tab: 'home', decks: [], config: CONFIG, dataEpoch: 0, contentEpoch: 0 })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  host.remove()
  vi.restoreAllMocks()
})

async function mount() {
  await act(async () => {
    root.render(<MainApp />)
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('撤销栈被热加载作废时的提示', () => {
  it('收到作废事件后显示丢掉的步数', async () => {
    await mount()
    expect(host.textContent).not.toContain('撤销历史已清空')

    await act(async () => {
      fireUndoDiscarded(3)
    })
    expect(host.textContent).toContain('撤销历史已清空')
    expect(host.textContent).toContain('3 步')
    // 必须说明数据本身没受影响，否则用户会以为丢了复习记录
    expect(host.textContent).toContain('复习数据本身没有受影响')
  })

  it('点「知道了」后提示消失', async () => {
    await mount()
    await act(async () => {
      fireUndoDiscarded(1)
    })
    const banner = [...host.querySelectorAll('.damage-banner')].find((el) => el.textContent?.includes('撤销历史已清空'))
    expect(banner).toBeTruthy()
    await act(async () => {
      ;(banner!.querySelector('.damage-dismiss') as HTMLButtonElement).click()
    })
    expect(host.textContent).not.toContain('撤销历史已清空')
  })

  it('一次性事件：普通的工作区热加载（未作废撤销栈）不弹这条提示', async () => {
    await mount()
    await act(async () => {
      fireWorkspaceChanged()
      await Promise.resolve()
    })
    expect(host.textContent).not.toContain('撤销历史已清空')
  })
})
