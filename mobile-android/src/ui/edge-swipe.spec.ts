// 抽屉手势判定的用例。这里钉住的是"什么算一次手势"，真机上的手感（阈值合不合适）不在这里。
import { describe, expect, it } from 'vitest'
import { shouldCloseDrawer, shouldOpenDrawer } from './edge-swipe'

describe('左边缘右滑打开抽屉', () => {
  it('从边缘出发、横向位移占主导且够远 → 打开', () => {
    expect(shouldOpenDrawer({ x: 2, y: 400 }, { x: 200, y: 410 }, true)).toBe(true)
  })

  it('起点不在左边缘 → 不算（页面中间的滑动不该拉出抽屉）', () => {
    expect(shouldOpenDrawer({ x: 200, y: 400 }, { x: 400, y: 400 }, true)).toBe(false)
  })

  it('纵向为主 → 不算（从边缘起手也可能是滚动页面）', () => {
    expect(shouldOpenDrawer({ x: 2, y: 800 }, { x: 40, y: 400 }, true)).toBe(false)
  })

  it('滑得不够远 → 不算（避免误触）', () => {
    expect(shouldOpenDrawer({ x: 2, y: 400 }, { x: 40, y: 402 }, true)).toBe(false)
  })

  it('当前不允许打开（学习页、已有弹层）→ 即使手势成立也不算', () => {
    expect(shouldOpenDrawer({ x: 2, y: 400 }, { x: 200, y: 400 }, false)).toBe(false)
  })
})

describe('抽屉内左滑关闭', () => {
  it('向左滑够远 → 关闭', () => {
    expect(shouldCloseDrawer({ x: 300, y: 400 }, { x: 100, y: 405 })).toBe(true)
  })

  it('向右滑 → 不关闭（同一个方向不该有两个含义）', () => {
    expect(shouldCloseDrawer({ x: 100, y: 400 }, { x: 300, y: 400 })).toBe(false)
  })

  it('纵向为主 → 不关闭（抽屉里也可能滚动）', () => {
    expect(shouldCloseDrawer({ x: 300, y: 800 }, { x: 260, y: 400 })).toBe(false)
  })
})
