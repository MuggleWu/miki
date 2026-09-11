// 原子写与半写恢复的测试：全部跑在内存 FileStore 上。
//
// 断言的重点是「破坏性窗口里数据不能丢」，而不是"调用了哪几个 API"：
//   · tmp 写失败 → 主文件一个字节都没动；
//   · 改名失败 → tmp 里留着完整内容，下次加载能兜底读回来；
//   · 主文件半写/缺失 + tmp 完整 → readJsonDoc 从 tmp 取值并标记来源。
import { describe, expect, it } from 'vitest'
import { MemoryFileStore } from './memory-fs'
import { ATOMIC_TMP_SUFFIX, atomicWriteText, readJsonDoc, tmpPathOf } from './atomic-write'

class FailTmpWriteStore extends MemoryFileStore {
  override async writeText(path: string, data: string): Promise<void> {
    if (path.endsWith(ATOMIC_TMP_SUFFIX)) throw new Error('磁盘满')
    return super.writeText(path, data)
  }
}

class FailRenameStore extends MemoryFileStore {
  override async rename(_from: string, _to: string): Promise<void> {
    throw new Error('改名失败')
  }
}

describe('原子写', () => {
  it('正常路径：写完目标是新内容，不留 tmp', async () => {
    const fs = new MemoryFileStore()
    fs.seed('decks.json', '旧内容')
    await atomicWriteText(fs, 'decks.json', '新内容')
    expect(await fs.readText('decks.json')).toBe('新内容')
    expect(await fs.readText(tmpPathOf('decks.json'))).toBeNull()
    // 关键：先写 tmp 再改名，且**没有**直接覆盖主文件的那次写（内存替身的 rename 内部会 remove 目标）
    expect(fs.calls).toContain('write:decks.json.tmp')
    expect(fs.calls).toContain('rename:decks.json.tmp->decks.json')
    expect(fs.calls).not.toContain('write:decks.json')
  })

  it('tmp 写失败时主文件保持原样（半写不会覆盖掉好文件）', async () => {
    const fs = new FailTmpWriteStore()
    fs.seed('decks.json', '旧内容')
    await expect(atomicWriteText(fs, 'decks.json', '新内容')).rejects.toThrow('磁盘满')
    expect(await fs.readText('decks.json')).toBe('旧内容')
  })

  it('改名失败时 tmp 留着完整内容，主文件不动（下次加载可兜底）', async () => {
    const fs = new FailRenameStore()
    fs.seed('decks.json', '旧内容')
    await expect(atomicWriteText(fs, 'decks.json', '新内容')).rejects.toThrow('改名失败')
    expect(await fs.readText('decks.json')).toBe('旧内容')
    expect(await fs.readText(tmpPathOf('decks.json'))).toBe('新内容')
  })
})

describe('JSON 文档读取（含 tmp 兜底）', () => {
  it('主文件正常：不标损坏、不走兜底', async () => {
    const fs = new MemoryFileStore()
    fs.seed('decks.json', '{"a":1}')
    fs.seed('decks.json.tmp', '{"a":2}')
    expect(await readJsonDoc<{ a: number }>(fs, 'decks.json')).toEqual({
      value: { a: 1 },
      mainCorrupt: false,
      fromTmp: false
    })
  })

  it('主文件半写 + tmp 完整：从 tmp 取值，并标记"主文件损坏"与"来自兜底"', async () => {
    const fs = new MemoryFileStore()
    fs.seed('decks.json', '[{"id":"d1"') // 半截 JSON
    fs.seed('decks.json.tmp', '[{"id":"d1"},{"id":"d2"}]')
    const doc = await readJsonDoc<{ id: string }[]>(fs, 'decks.json')
    expect(doc.value?.map((d) => d.id)).toEqual(['d1', 'd2'])
    expect(doc.mainCorrupt).toBe(true)
    expect(doc.fromTmp).toBe(true)
  })

  it('主文件缺失 + tmp 完整：算"文件不存在"，不算损坏', async () => {
    const fs = new MemoryFileStore()
    fs.seed('decks.json.tmp', '[]')
    expect(await readJsonDoc(fs, 'decks.json')).toEqual({ value: [], mainCorrupt: false, fromTmp: true })
  })

  it('两者都坏：值为 null，但损坏标记要留着（好让健康报告说得出来）', async () => {
    const fs = new MemoryFileStore()
    fs.seed('decks.json', '坏')
    fs.seed('decks.json.tmp', '也坏')
    expect(await readJsonDoc(fs, 'decks.json')).toEqual({ value: null, mainCorrupt: true, fromTmp: false })
  })

  it('两者都没有：干净的空', async () => {
    const fs = new MemoryFileStore()
    expect(await readJsonDoc(fs, 'decks.json')).toEqual({ value: null, mainCorrupt: false, fromTmp: false })
  })
})
