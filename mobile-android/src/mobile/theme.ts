// 本机显示偏好：主题、字号、屏幕常亮。
//
// 解析逻辑单独放这里（而不是散在组件里），因为它有两个容易写错的点：
// 1. 「跟随系统」意味着系统切深浅色时要跟着变——只在启动时读一次 matchMedia 是不够的。
// 2. 字号只影响正文类文本，不能连带把按钮高度、间距一起放大，否则单手够不到底部的评级按钮。
import type { Theme } from '@shared/types'

export type ThemePref = Theme | 'system'
export type FontScale = 'small' | 'medium' | 'large'

export const FONT_SCALE_VALUE: Record<FontScale, number> = { small: 0.92, medium: 1, large: 1.18 }

/** 把偏好 + 当前系统深浅色解析成实际生效的主题 */
export function resolveTheme(pref: ThemePref, systemDark: boolean): Theme {
  if (pref === 'system') return systemDark ? 'dark' : 'light'
  return pref
}

/** 把主题与字号写到 <html> 上；CSS 只认这两个属性，不认偏好本身 */
export function applyAppearance(pref: ThemePref, scale: FontScale, systemDark: boolean): void {
  const root = document.documentElement
  root.dataset.theme = resolveTheme(pref, systemDark)
  root.style.setProperty('--fs-scale', String(FONT_SCALE_VALUE[scale]))
}

/** 订阅系统深浅色变化（仅当偏好为 system 时才有意义，调用方自己判断） */
export function watchSystemDark(onChange: (dark: boolean) => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = (e: MediaQueryListEvent): void => onChange(e.matches)
  mq.addEventListener('change', handler)
  return () => mq.removeEventListener('change', handler)
}

/**
 * 屏幕常亮：用 WebView 自带的 Screen Wake Lock API，不引第三方插件。
 * 需要 https 安全上下文——Capacitor 的本地页面正是 https://localhost，满足条件。
 * 返回一个释放函数；不支持时返回 null（调用方静默跳过，不打扰用户）。
 */
export async function acquireWakeLock(): Promise<(() => void) | null> {
  const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } }
  if (!nav.wakeLock) return null
  try {
    const sentinel = await nav.wakeLock.request('screen')
    return () => void sentinel.release()
  } catch {
    // 电量低、页面不可见等情况下浏览器会拒绝，这是正常拒绝而非错误
    return null
  }
}

interface WakeLockSentinelLike {
  release(): Promise<void>
}
