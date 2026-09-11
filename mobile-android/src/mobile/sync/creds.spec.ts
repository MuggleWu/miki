// 同步凭据与同步记账的读写测试。
//
// 真机上这些值落在 Capacitor Preferences（应用私有 SharedPreferences），node 里没有原生桥，
// 所以用 vi.hoisted 建一个内存后端顶掉插件。这里要钉住的不变量只有一条但很贵：
// **换了仓库/分支就必须作废 sync.base** —— 旧记账留着会让新仓库里的文件被判成
// 「两侧都没改」而永远推不上去，界面却报成功（假备份）。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { prefs } = vi.hoisted(() => ({ prefs: new Map<string, string>() }))

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: prefs.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => {
      prefs.set(key, value)
    },
    remove: async ({ key }: { key: string }) => {
      prefs.delete(key)
    }
  }
}))

import { PREF_KEYS } from '../prefs'
import { applySyncConfig, clearBase, loadBase, loadCreds, saveBase, saveCreds } from './creds'
import { emptyBase } from './types'

const someBase = () => ({
  commit: 'c1',
  remoteSha: { 'decks.json': 'sha-old' },
  localHash: { 'decks.json': 'hash-old' }
})

describe('同步目标变更时的记账作废', () => {
  beforeEach(async () => {
    prefs.clear()
    await saveCreds('me/old-repo', 'main', 'tok-1')
    await saveBase(someBase())
    prefs.set(PREF_KEYS.syncVerify, JSON.stringify({ at: 1, ok: true, message: 'ok' }))
  })

  it('目标没变（只重存一次）：记账保留，不需要全量重比', async () => {
    const { switched } = await applySyncConfig('me/old-repo', 'main', null)
    expect(switched).toBe(false)
    expect((await loadBase()).remoteSha).toEqual({ 'decks.json': 'sha-old' })
    expect(prefs.get(PREF_KEYS.syncVerify)).toBeDefined()
    // token 传 null = 不改已存的 PAT
    expect((await loadCreds()).token).toBe('tok-1')
  })

  it('换了仓库：base 与验证记录一起作废（否则新仓库里的文件永远推不上去）', async () => {
    const { switched, creds } = await applySyncConfig('me/new-repo', 'main', null)
    expect(switched).toBe(true)
    expect(creds.repo).toBe('me/new-repo')
    expect(await loadBase()).toEqual(emptyBase())
    expect(prefs.get(PREF_KEYS.syncVerify)).toBeUndefined()
  })

  it('换了分支：同样作废', async () => {
    const { switched } = await applySyncConfig('me/old-repo', 'drill', null)
    expect(switched).toBe(true)
    expect(await loadBase()).toEqual(emptyBase())
  })

  it('仓库写法不同但归一化后是同一个：不算换目标，记账保留', async () => {
    // 早期版本允许把整串地址存进来，loadCreds 会归一化——比较必须发生在归一化之后
    const { switched } = await applySyncConfig('https://github.com/me/old-repo.git', 'main', null)
    expect(switched).toBe(false)
    expect((await loadBase()).remoteSha).toEqual({ 'decks.json': 'sha-old' })
  })

  it('clearBase 只清记账与验证，不动凭据', async () => {
    await clearBase()
    expect(await loadBase()).toEqual(emptyBase())
    expect(prefs.get(PREF_KEYS.githubRepo)).toBe('me/old-repo')
    expect(prefs.get(PREF_KEYS.githubPat)).toBe('tok-1')
  })
})
