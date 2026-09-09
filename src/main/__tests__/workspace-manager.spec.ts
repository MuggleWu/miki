// WorkspaceManager 单测：临时目录 + 真实 fs 覆盖启动解析/引导确认/添加/切换/移除全链路
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { WorkspaceManager, type WorkspaceManagerDeps } from '../workspace-manager'

const tmps: string[] = []
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'miki-wsm-'))
  tmps.push(d)
  return d
}
afterEach(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true })
  tmps.length = 0
})

/** 真实文件依赖：指针文件 = <root>/workspace.json，与 index.ts 的 userData 接线同构 */
function makeDeps(root = tmp()): WorkspaceManagerDeps {
  const file = path.join(root, 'workspace.json')
  return {
    readPointer: () => {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'))
      } catch {
        return null
      }
    },
    writePointer: (reg) => fs.writeFileSync(file, JSON.stringify(reg, null, 2), 'utf-8'),
    isDirectory: (p) => {
      try {
        return fs.statSync(p).isDirectory()
      } catch {
        return false
      }
    },
    makeDirectory: (p) => fs.mkdirSync(p, { recursive: true }),
    defaultSuggestion: () => path.join(root, 'miki-base'),
    now: () => 1700000000000
  }
}

describe('WorkspaceManager.resolveInitial', () => {
  it('环境变量覆盖只影响当次运行：返回该路径且不写回指针文件', () => {
    const root = tmp()
    const m = new WorkspaceManager(makeDeps(root))
    const p = path.join(root, 'env-ws')
    expect(m.resolveInitial(p)).toBe(p)
    expect(fs.existsSync(path.join(root, 'workspace.json'))).toBe(false)
  })

  it('指针有效时返回 current 并刷新注册表', () => {
    const root = tmp()
    const p = path.join(root, 'ws-a')
    fs.mkdirSync(p)
    const dep = makeDeps(root)
    dep.writePointer({ current: p, workspaces: [{ path: p, name: 'ws-a', lastOpenedAt: 1 }] })
    const m = new WorkspaceManager(dep)
    expect(m.resolveInitial(null)).toBe(p)
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'workspace.json'), 'utf-8'))
    expect(saved.workspaces[0]!.lastOpenedAt).toBe(1700000000000)
  })

  it('指针缺失/指向已删除目录 → null（需要引导），原始记录保留', () => {
    const root = tmp()
    const dep = makeDeps(root)
    dep.writePointer({
      current: path.join(root, 'gone'),
      workspaces: [{ path: path.join(root, 'gone'), name: 'gone', lastOpenedAt: 0 }]
    })
    const m = new WorkspaceManager(dep)
    expect(m.resolveInitial(null)).toBeNull()
    expect(m.getStatus(true).workspaces).toHaveLength(1) // 列表不清空，供用户修复
  })
})

describe('WorkspaceManager.confirmOnboarding / add / switchTo / remove', () => {
  it('引导确认：创建目录 + 设为当前 + 指针落盘', () => {
    const root = tmp()
    const m = new WorkspaceManager(makeDeps(root))
    const p = path.join(root, '新档案')
    expect(m.confirmOnboarding(p)).toEqual({ ok: true })
    expect(fs.statSync(p).isDirectory()).toBe(true)
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'workspace.json'), 'utf-8'))
    expect(saved.current).toBe(p)
  })

  it('引导确认：创建失败返回错误', () => {
    const root = tmp()
    const m = new WorkspaceManager(makeDeps(root))
    const blocker = path.join(root, 'blocker')
    fs.writeFileSync(blocker, 'x') // 同名文件挡路，mkdir 必败
    const r = m.confirmOnboarding(blocker)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('无法创建文件夹')
  })

  it('登记工作区：不存在则自动创建，且不改 current', () => {
    const root = tmp()
    const cur = path.join(root, 'cur')
    fs.mkdirSync(cur)
    const m = new WorkspaceManager(makeDeps(root))
    void m.confirmOnboarding(cur)
    const other = path.join(root, 'new-ws')
    expect(m.add(other)).toEqual({ ok: true })
    expect(fs.statSync(other).isDirectory()).toBe(true)
    expect(m.getStatus(false).current).toBe(cur)
    expect(m.getStatus(false).workspaces.map((w) => w.path)).toContain(other)
  })

  it('登记工作区：路径被同名文件挡住时返回错误', () => {
    const root = tmp()
    const m = new WorkspaceManager(makeDeps(root))
    const blocker = path.join(root, 'blocker')
    fs.writeFileSync(blocker, 'x')
    expect(m.add(blocker).ok).toBe(false)
  })

  it('切换：目录必须存在；成功后 current 更新', () => {
    const root = tmp()
    const a = path.join(root, 'a')
    const b = path.join(root, 'b')
    fs.mkdirSync(a)
    fs.mkdirSync(b)
    const m = new WorkspaceManager(makeDeps(root))
    void m.confirmOnboarding(a)
    expect(m.switchTo(path.join(root, 'nope')).ok).toBe(false)
    expect(m.switchTo(a).ok).toBe(false) // 已是当前
    expect(m.switchTo(b)).toEqual({ ok: true })
    expect(m.getStatus(false).current).toBe(b)
  })

  it('移除：当前不可移除；其他可移除', () => {
    const root = tmp()
    const a = path.join(root, 'a')
    const b = path.join(root, 'b')
    fs.mkdirSync(a)
    fs.mkdirSync(b)
    const m = new WorkspaceManager(makeDeps(root))
    void m.confirmOnboarding(a)
    void m.add(b)
    expect(m.remove(a).ok).toBe(false)
    expect(m.remove(b)).toEqual({ ok: true })
    expect(m.getStatus(false).workspaces.map((w) => w.path)).toEqual([a])
  })

  it('旧格式指针 {workspacePath} 可直接被识别并继续切换', () => {
    const root = tmp()
    const old = path.join(root, 'legacy')
    fs.mkdirSync(old)
    const dep = makeDeps(root)
    dep.writePointer({ workspacePath: old } as unknown as Parameters<WorkspaceManagerDeps['writePointer']>[0])
    const m = new WorkspaceManager(dep)
    expect(m.resolveInitial(null)).toBe(old)
  })
})
