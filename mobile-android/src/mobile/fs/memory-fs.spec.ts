import { describe, expect, it } from 'vitest'
import { MemoryFileStore } from './memory-fs'
import { normalizeRelPath, parentDir } from './types'

describe('路径规范化', () => {
  it('去掉前导/结尾斜杠与重复斜杠，反斜杠按分隔符处理', () => {
    expect(normalizeRelPath('/a//b/c/')).toBe('a/b/c')
    expect(normalizeRelPath('a\\b')).toBe('a/b')
    expect(normalizeRelPath('./a/./b')).toBe('a/b')
    expect(normalizeRelPath('/')).toBe('')
  })

  it('父目录：顶层为空串', () => {
    expect(parentDir('a/b/c.ndjson')).toBe('a/b')
    expect(parentDir('a')).toBe('')
  })
})

describe('MemoryFileStore 与 Capacitor 实现对齐的语义', () => {
  it('读不存在的文件返回 null，而不是抛错', async () => {
    const fs = new MemoryFileStore()
    expect(await fs.readText('nope/x.ndjson')).toBeNull()
    expect(await fs.stat('nope/x.ndjson')).toBeNull()
    expect(await fs.list('nope')).toEqual([])
  })

  it('write → read 往返一致，append 是追加而不是覆盖', async () => {
    const fs = new MemoryFileStore()
    await fs.writeText('ws/cards/1.ndjson', '{"n":1}\n')
    expect(await fs.readText('ws/cards/1.ndjson')).toBe('{"n":1}\n')
    await fs.appendText('ws/cards/1.ndjson', '{"n":2}\n')
    expect(await fs.readText('ws/cards/1.ndjson')).toBe('{"n":1}\n{"n":2}\n')
  })

  it('父目录不存在时写入自动建目录（与 Capacitor 的 recursive 行为对齐）', async () => {
    const fs = new MemoryFileStore()
    await fs.writeText('ws/deep/a/b/c.ndjson', 'x')
    expect(await fs.list('ws/deep/a/b')).toEqual([
      { name: 'c.ndjson', type: 'file', size: 1, mtimeMs: expect.any(Number) }
    ])
  })

  it('size 按 UTF-8 字节数算，不是字符数', async () => {
    const fs = new MemoryFileStore()
    await fs.writeText('ws/x.ndjson', '中文')
    expect((await fs.stat('ws/x.ndjson'))?.size).toBe(6)
  })

  it('remove 递归清目录，且不存在时是 no-op', async () => {
    const fs = new MemoryFileStore()
    await fs.writeText('ws/cards/1.ndjson', 'a')
    await fs.writeText('ws/cards/2.ndjson', 'b')
    await fs.remove('ws/cards')
    expect(await fs.stat('ws/cards/1.ndjson')).toBeNull()
    expect(await fs.list('ws')).toEqual([])
    await expect(fs.remove('ws/cards')).resolves.toBeUndefined()
  })

  it('rename 覆盖已存在的目标（对齐桌面端 renameSync 语义）', async () => {
    const fs = new MemoryFileStore()
    await fs.writeText('ws/a.ndjson', 'A')
    await fs.writeText('ws/b.ndjson', 'B')
    await fs.rename('ws/a.ndjson', 'ws/b.ndjson')
    expect(await fs.readText('ws/b.ndjson')).toBe('A')
    expect(await fs.readText('ws/a.ndjson')).toBeNull()
  })

  it('rename 源不存在时抛错，且不留下任何目标（对齐真机 Filesystem.rename 的失败语义）', async () => {
    const fs = new MemoryFileStore()
    await expect(fs.rename('ws/missing.ndjson', 'ws/target.ndjson')).rejects.toThrow('源不存在')
    // 回归护栏：以前源不存在会落进「目录改名」兜底分支，静默造出一个空目标——stat 非 null 却读不出内容，
    // 于是所有依赖「rename 失败要报错」的用例在 node 里都假通过（例如 tmp 缺失时的原子写路径）。
    expect(await fs.stat('ws/target.ndjson')).toBeNull()
    expect(await fs.readText('ws/target.ndjson')).toBeNull()
    expect(await fs.list('ws')).toEqual([])
  })

  it('rename 源是目录时整体平移前缀，旧目录不留残影', async () => {
    const fs = new MemoryFileStore()
    await fs.writeText('ws/sub/a.ndjson', 'A')
    await fs.writeText('ws/sub/deep/b.ndjson', 'B')
    await fs.rename('ws/sub', 'ws/renamed')
    expect(await fs.readText('ws/renamed/a.ndjson')).toBe('A')
    expect(await fs.readText('ws/renamed/deep/b.ndjson')).toBe('B')
    expect(await fs.stat('ws/sub/a.ndjson')).toBeNull()
    expect(await fs.stat('ws/sub')).toBeNull()
    expect((await fs.list('ws')).map((e) => e.name)).toEqual(['renamed'])
  })

  it('list 只列直接子项，目录与文件都标对类型', async () => {
    const fs = new MemoryFileStore()
    await fs.writeText('ws/1.ndjson', 'a')
    await fs.writeText('ws/sub/2.ndjson', 'b')
    const entries = await fs.list('ws')
    expect(entries.map((e) => [e.name, e.type])).toEqual([
      ['1.ndjson', 'file'],
      ['sub', 'directory']
    ])
  })
})
