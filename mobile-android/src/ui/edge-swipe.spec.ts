// 抽屉手势的判定规则单测：跟手偏移的钳制、松手落点、横竖方向判定。
// 这些是"手感"里唯一能被穷举验证的部分——剩下的（跟手是否顺畅）只能在真机上试。
import { describe, expect, it } from 'vitest'
import {
  dragAxis,
  dragOffsetFromClosed,
  dragOffsetFromOpen,
  dragVelocity,
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
  it('位置判定：过半就开，没过半就收——两侧各自贴着边界', () => {
    expect(shouldSnapOpen(-W + 1, W)).toBe(false) // 刚露出一点点，收回
    expect(shouldSnapOpen(-W / 2 - 1, W)).toBe(false) // 差一点，收回
    expect(shouldSnapOpen(-W / 2 + 1, W)).toBe(true) // 刚刚过半，打开
    expect(shouldSnapOpen(0, W)).toBe(true)
  })

  it('轻轻一甩就算数：位移远不到半宽，但甩得够快，按方向展开', () => {
    // 收起状态下往右轻扫 60px 松手（位置仍接近收起）
    expect(shouldSnapOpen(-W + 60, W, 0.8, 60)).toBe(true)
  })

  it('反方向同理：全开时往左轻轻一甩就关', () => {
    // 偏移 -60（离收起还远），但速度向左
    expect(shouldSnapOpen(-60, W, -0.8, 60)).toBe(false)
  })

  it('速度不够就还是按位置判定（慢拖到一半松手不会因为速度小就反着来）', () => {
    expect(shouldSnapOpen(-W + 60, W, 0.1, 60)).toBe(false) // 慢拖 60px，仍在收起的半边
    expect(shouldSnapOpen(-60, W, -0.1, 60)).toBe(true) // 慢拖 60px，仍在打开的半边
    expect(shouldSnapOpen(-W + 200, W, 0.2, 200)).toBe(true) // 慢拖但过了半宽
  })

  it('位移太小不翻状态：挡掉"手指抖一下但瞬时速度很大"', () => {
    expect(shouldSnapOpen(-W + 8, W, 2.0, 8)).toBe(false)
    expect(shouldSnapOpen(-8, W, -2.0, 8)).toBe(true)
  })
})

describe('速度取样', () => {
  it('只看最近 100ms：更早的大位移不算"甩"', () => {
    // t=0 起手，t=300 已经到 200px（早就慢下来了），t=400 在 260px
    const s = dragVelocity([
      { x: 0, t: 0 },
      { x: 200, t: 300 },
      { x: 260, t: 400 }
    ])
    expect(s).toBeCloseTo(0.6, 5) // 60px / 100ms
  })

  it('采样不足或时间没走，速度为 0（宁可按位置判定）', () => {
    expect(dragVelocity([])).toBe(0)
    expect(dragVelocity([{ x: 10, t: 0 }])).toBe(0)
    expect(
      dragVelocity([
        { x: 0, t: 5 },
        { x: 20, t: 5 }
      ])
    ).toBe(0)
  })

  it('往左甩是负速度', () => {
    expect(
      dragVelocity([
        { x: 300, t: 0 },
        { x: 240, t: 100 }
      ])
    ).toBeCloseTo(-0.6, 5)
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
