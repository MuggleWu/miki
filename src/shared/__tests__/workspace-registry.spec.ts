// workspace-registry 单测：normalizeRegistry 信任边界 / upsert / remove / 兼容旧指针格式
import { describe, expect, it } from 'vitest'
import {
  defaultWorkspaceSuggestion,
  normalizeRegistry,
  removeWorkspace,
  upsertWorkspace,
  workspaceName
} from '../workspace'

describe('workspaceName', () => {
  it('取末段文件夹名', () => {
    expect(workspaceName('/Users/w/miki-base')).toBe('miki-base')
    expect(workspaceName('C:\\Users\\w\\我的档案')).toBe('我的档案')
    expect(workspaceName('/')).toBe('/')
  })
})

describe('defaultWorkspaceSuggestion', () => {
  it('拼接 home 与 miki-base', () => {
    expect(defaultWorkspaceSuggestion('/Users/w', '/')).toBe('/Users/w/miki-base')
    expect(defaultWorkspaceSuggestion('C:\\Users\\w', '\\')).toBe('C:\\Users\\w\\miki-base')
  })
})

describe('normalizeRegistry', () => {
  it('旧格式 {workspacePath} 升级为单条记录 + current', () => {
    const reg = normalizeRegistry({ workspacePath: '/a/b' })
    expect(reg.current).toBe('/a/b')
    expect(reg.workspaces).toEqual([{ path: '/a/b', name: 'b', lastOpenedAt: 0 }])
  })

  it('新格式完整读取并按 lastOpenedAt 降序', () => {
    const reg = normalizeRegistry({
      current: '/a/b',
      workspaces: [
        { path: '/a/b', name: 'b', lastOpenedAt: 100 },
        { path: '/c/d', name: 'd', lastOpenedAt: 200 }
      ]
    })
    expect(reg.workspaces.map((w) => w.path)).toEqual(['/c/d', '/a/b'])
    expect(reg.current).toBe('/a/b')
  })

  it('坏字段一律丢弃：非对象、path 非字符串/空、lastOpenedAt 非数字（NaN 归零不污染排序）', () => {
    const reg = normalizeRegistry({
      current: '/ok',
      workspaces: [
        null,
        'x',
        {},
        { path: '', lastOpenedAt: 5 },
        { path: '/ok', lastOpenedAt: 'no' },
        { path: '/nan', lastOpenedAt: Number.NaN }
      ]
    })
    expect(reg.workspaces).toEqual([
      { path: '/nan', name: 'nan', lastOpenedAt: 0 },
      { path: '/ok', name: 'ok', lastOpenedAt: 0 }
    ])
  })

  it('current 指向的工作区缺记录时自愈补一条', () => {
    const reg = normalizeRegistry({ current: '/x/y', workspaces: [{ path: '/a/b', lastOpenedAt: 1 }] })
    expect(reg.workspaces.map((w) => w.path).sort()).toEqual(['/a/b', '/x/y'])
    expect(reg.current).toBe('/x/y')
  })

  it('完全非法输入返回空注册表', () => {
    expect(normalizeRegistry(null)).toEqual({ current: null, workspaces: [] })
    expect(normalizeRegistry('x')).toEqual({ current: null, workspaces: [] })
    expect(normalizeRegistry(42)).toEqual({ current: null, workspaces: [] })
  })
})

describe('upsertWorkspace', () => {
  it('新路径追加并置顶，不改入参', () => {
    const reg = normalizeRegistry({ current: '/a/b', workspaces: [{ path: '/a/b', lastOpenedAt: 1 }] })
    const next = upsertWorkspace(reg, '/c/d', 99)
    expect(next.workspaces.map((w) => w.path)).toEqual(['/c/d', '/a/b'])
    expect(next.current).toBe('/a/b') // upsert 不改 current，切换由切换流程负责
    expect(reg.workspaces).toHaveLength(1) // 原对象未变
  })

  it('已有路径只刷新时间戳（取较大值）', () => {
    const reg = normalizeRegistry({ workspaces: [{ path: '/a/b', lastOpenedAt: 50 }] })
    const next = upsertWorkspace(reg, '/a/b', 60)
    expect(next.workspaces).toEqual([{ path: '/a/b', name: 'b', lastOpenedAt: 60 }])
    const back = upsertWorkspace(next, '/a/b', 10)
    expect(back.workspaces[0]!.lastOpenedAt).toBe(60)
  })
})

describe('removeWorkspace', () => {
  it('移除非 current 保留 current', () => {
    const reg = normalizeRegistry({ current: '/a/b', workspaces: [{ path: '/a/b' }, { path: '/c/d' }] })
    const next = removeWorkspace(reg, '/c/d')
    expect(next.workspaces.map((w) => w.path)).toEqual(['/a/b'])
    expect(next.current).toBe('/a/b')
  })

  it('移除 current 时一并置空', () => {
    const reg = normalizeRegistry({ current: '/a/b', workspaces: [{ path: '/a/b' }, { path: '/c/d' }] })
    const next = removeWorkspace(reg, '/a/b')
    expect(next.workspaces.map((w) => w.path)).toEqual(['/c/d'])
    expect(next.current).toBeNull()
  })
})
