// 显示偏好相关的纯逻辑测试。applyAppearance 依赖 DOM，这里只测它能被测的部分：
// 解析规则本身——因为「跟随系统」的判断错了，用户会看到"设置成深色但界面还是白的"这种
// 一眼就怪、但排查起来要翻好几层的现象。
import { describe, expect, it } from 'vitest'
import { FONT_SCALE_VALUE, resolveTheme } from './theme'

describe('主题解析', () => {
  it('跟随系统：按系统深浅色给出结果', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('显式选择优先于系统：系统是深色也照旧按用户选的浅色', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})

describe('字号档位', () => {
  it('三档单调递增，中档为 1（不缩放）', () => {
    expect(FONT_SCALE_VALUE.small).toBeLessThan(FONT_SCALE_VALUE.medium)
    expect(FONT_SCALE_VALUE.medium).toBe(1)
    expect(FONT_SCALE_VALUE.large).toBeGreaterThan(FONT_SCALE_VALUE.medium)
  })

  it('放大档不放得太狠：单手够底部按钮是硬约束', () => {
    expect(FONT_SCALE_VALUE.large).toBeLessThanOrEqual(1.2)
  })
})
