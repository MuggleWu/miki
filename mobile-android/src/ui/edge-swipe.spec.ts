// 抽屉手势的判定规则单测：跟手偏移的钳制、松手落点、横竖方向判定。
// 这些是"手感"里唯一能被穷举验证的部分——剩下的（跟手是否顺畅）只能在真机上试。
import { describe, expect, it } from 'vitest'
import {
  dragAxis,
  dragOffsetFromClosed,
  dragOffsetFromOpen,
  drawerProgress,
  inEdgeZone,
  shouldSnapOpen,
  EDGE
} from './edge-swipe'

const W = 320

describe('起手区', () => {
  it('左边一小条算边缘，再往右就不抢手势', () => {
    expect(inEdgeZone(0)).toBe(true)
    expect(inEdgeZone(EDGE)).toBe(true)
    expect(inEdgeZone(EDGE + 1)).toBe(false)
    expect(inEdgeZone(120)).toBe(false)
  })
})

describe('跟手偏移', () => {
  it('从关闭开始右拖：位移多少就露出多少', () => {
    expect(dragOffsetFromClosed(0, W)).toBe(-W)
    expect(dragOffsetFromClosed(80, W)).toBe(-240)
    expect(dragOffsetFromClosed(W, W)).toBe(0)
  })

  it('拖过头不会把抽屉拉出屏幕，也不会推过全开', () => {
    expect(dragOffsetFromClosed(-500, W)).toBe(-W)
    expect(dragOffsetFromClosed(9999, W)).toBe(0)
  })

  it('从打开开始左拖：位移多少就收起多少', () => {
    expect(dragOffsetFromOpen(0, W)).toBe(0)
    expect(dragOffsetFromOpen(-90, W)).toBe(-90)
    expect(dragOffsetFromOpen(-9999, W)).toBe(-W)
  })

  it('右拖（想往回推）被钳在 0，不会把抽屉推到屏幕外', () => {
    expect(dragOffsetFromOpen(60, W)).toBe(0)
  })
})

describe('松手落点', () => {
  it('过半就开，没过半就收——两侧各自贴着边界', () => {
    expect(shouldSnapOpen(-W + 1, W)).toBe(false) // 刚露出一点点，收回
    expect(shouldSnapOpen(-W / 2 - 1, W)).toBe(false) // 差一点，收回
    expect(shouldSnapOpen(-W / 2 + 1, W)).toBe(true) // 刚刚过半，打开
    expect(shouldSnapOpen(0, W)).toBe(true)
  })
})

describe('方向判定', () => {
  it('位移太小先不下结论', () => {
    expect(dragAxis({ x: 10, y: 10 }, { x: 12, y: 11 })).toBe('none')
  })

  it('横向占优才算拖抽屉', () => {
    expect(dragAxis({ x: 10, y: 10 }, { x: 60, y: 20 })).toBe('horizontal')
    expect(dragAxis({ x: 10, y: 10 }, { x: 20, y: 60 })).toBe('vertical')
  })

  it('斜着划按纵向算（页面滚动优先，抽屉不抢）', () => {
    // dx=40 dy=35：横向只占 1.14 倍，不到 1.2 的门槛
    expect(dragAxis({ x: 0, y: 0 }, { x: 40, y: 35 })).toBe('vertical')
    expect(dragAxis({ x: 0, y: 0 }, { x: 40, y: 30 })).toBe('horizontal')
  })
})

describe('遮罩进度', () => {
  it('收起是 0，全开是 1，中间线性', () => {
    expect(drawerProgress(-W, W)).toBe(0)
    expect(drawerProgress(0, W)).toBe(1)
    expect(drawerProgress(-W / 2, W)).toBe(0.5)
  })

  it('宽度还没量到（0）时不至于除零', () => {
    expect(drawerProgress(-100, 0)).toBe(1)
  })
})
