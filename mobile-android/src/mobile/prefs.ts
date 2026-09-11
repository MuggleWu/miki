// 本机偏好：与工作区数据严格分开。
//
// 为什么不用 localStorage：它是 WebView 的存储，靠 WebView 自己的清理策略活着，
// 而 Capacitor Preferences 在 Android 上落在 SharedPreferences（应用私有、随应用数据清除）。
// 前者在"清除 WebView 数据/存储压力回收"时可能悄悄没了——偏好丢了不算大事，但"同步 PAT
// 丢了"就是大事，所以统一走 Preferences，别让两种存储各管一半。
//
// 这里只放**本机**偏好：主题、字号、上次用的牌组、同步配置。工作区数据（卡片/事件）不在此。
import { Preferences } from '@capacitor/preferences'

/** 偏好键名集中在此，避免各处写字面量拼错 */
export const PREF_KEYS = {
  lastDeckId: 'miki.lastDeckId',
  githubRepo: 'miki.sync.repo',
  githubPat: 'miki.sync.pat',
  lastSyncAt: 'miki.sync.lastAt'
} as const

export async function prefGet(key: string): Promise<string | null> {
  try {
    const { value } = await Preferences.get({ key })
    return value
  } catch {
    // 插件不可用（浏览器里跑 dev）时视为没有偏好，不把整个页面带崩
    return null
  }
}

export async function prefSet(key: string, value: string): Promise<void> {
  try {
    await Preferences.set({ key, value })
  } catch {
    // 同上：偏好写失败不该让用户的操作失败
  }
}

export async function prefRemove(key: string): Promise<void> {
  try {
    await Preferences.remove({ key })
  } catch {
    // 同上
  }
}
