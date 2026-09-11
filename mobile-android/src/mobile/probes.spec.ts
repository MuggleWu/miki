// 探针逻辑本身的测试：两条探针都在内存实现上跑一遍。
// 这样「探针代码写错了」和「设备上真的不行」不会混在一起——先在这里证明探针是对的。
//
// 另有三类必须钉住的边界（前两条是已经踩过的）：
//   ① 落盘位置：参数里的 root 是**真实工作区**目录名，探针往里写就等于在用户数据里塞假卡；
//   ② 失败路径的清理：原来只在成功路径 remove，抛一次异常就在设备上留一份 ~2MB 的合成文件；
//   ③ 自检页文案与实现一致：文案说"跑在旁路目录里"，实现就必须真的在那儿。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MemoryFileStore } from './fs'
import { probeNdjsonPerf, probePrivateStorage } from './probes'

/** 读源码并剥掉注释（块注释 + 行注释，含行尾注释） */
function readSource(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/gm, '$1')
}

/** 断言所有落盘操作都发生在 `<root>__selfcheck` 这个旁路目录里（目录本身或它的子路径） */
function expectOnlySelfcheck(store: MemoryFileStore, root: string): void {
  expect(store.calls.length).toBeGreaterThan(0)
  expect(store.calls.every((c) => new RegExp(`^[a-z]+:${root}__selfcheck(/|$)`).test(c))).toBe(true)
  // 旧的 `<root>/__probe/…` 就是把假数据写进真实工作区
  expect(store.calls.some((c) => c.includes('/__probe'))).toBe(false)
}

describe('探针 1：应用私有目录读写', () => {
  it('在内存实现上全绿，且逐条证据齐全', async () => {
    const store = new MemoryFileStore()
    const r = await probePrivateStorage(store, 'miki-base')
    expect(r.status).toBe('pass')
    expect(r.note).toBeUndefined()
    // 证据里必须包含「真实路径」这条——设计文档的探针 1 明确要求记录实际落到哪
    expect(r.detail.some((d) => d.includes('实际路径'))).toBe(true)
    expect(r.detail.some((d) => d.includes('append→read'))).toBe(true)
    expect(r.detail.some((d) => d.includes('已删干净'))).toBe(true)
    // 跑完不留垃圾（旁路目录本身也删掉）
    expect(await store.stat('miki-base__selfcheck')).toBeNull()
  })

  it('全部读写都落在 __selfcheck 旁路目录里，不碰真实工作区', async () => {
    const store = new MemoryFileStore()
    await probePrivateStorage(store, 'miki-base')
    expectOnlySelfcheck(store, 'miki-base')
  })

  it('断言不成立时判 fail 并给出原因（不静默通过）', async () => {
    const store = new MemoryFileStore()
    // 破坏 append 语义：把追加实现成覆盖，探针必须抓到
    store.appendText = async (p: string, data: string): Promise<void> => {
      await store.writeText(p, data)
    }
    const r = await probePrivateStorage(store, 'miki-base')
    expect(r.status).toBe('fail')
    expect(r.note).toBeTruthy()
  })

  it('抛异常时也清理旁路目录（不在设备上留半截假文件）', async () => {
    const store = new MemoryFileStore()
    const realAppend = store.appendText.bind(store)
    store.appendText = async (p: string, data: string): Promise<void> => {
      // 先真的写进去再抛：不清理的话这份文件就留在设备上了
      await realAppend(p, data)
      throw new Error('桥断了')
    }
    const r = await probePrivateStorage(store, 'miki-base')
    expect(r.status).toBe('fail')
    expect(await store.stat('miki-base__selfcheck/probe/hello.ndjson')).toBeNull()
    expect(store.calls).toContain('remove:miki-base__selfcheck')
  })
})

describe('探针 2：NDJSON 追加耗时', () => {
  it('合成数据规模落在 MB 级，且给出 avg/p95', async () => {
    const store = new MemoryFileStore()
    const r = await probeNdjsonPerf(store, 'miki-base', { mb: 2, rounds: 10 })
    expect(r.status).toBe('pass')
    expect(r.detail.some((d) => /\d+ 行 \/ 2\.\d+ MB/.test(d))).toBe(true)
    expect(r.detail.some((d) => d.includes('p95'))).toBe(true)
    expect(await store.stat('miki-base__selfcheck')).toBeNull()
  })

  it('那份 MB 级合成文件也落在 __selfcheck 旁路目录里', async () => {
    const store = new MemoryFileStore()
    await probeNdjsonPerf(store, 'miki-base', { mb: 1, rounds: 3 })
    expectOnlySelfcheck(store, 'miki-base')
  })

  it('抛异常时也清掉合成文件（否则自检跑一次，设备白占 2MB）', async () => {
    const store = new MemoryFileStore()
    let appends = 0
    const realAppend = store.appendText.bind(store)
    store.appendText = async (p: string, data: string): Promise<void> => {
      if (++appends > 2) throw new Error('桥断了')
      await realAppend(p, data)
    }
    const r = await probeNdjsonPerf(store, 'miki-base', { mb: 1, rounds: 10 })
    expect(r.status).toBe('fail')
    // 先确认它真的写过（否则下面那条断言是空转）
    expect(store.calls.some((c) => c.startsWith('write:miki-base__selfcheck/'))).toBe(true)
    expect(await store.stat('miki-base__selfcheck/perf.ndjson')).toBeNull()
    expect(store.calls).toContain('remove:miki-base__selfcheck')
  })
})

describe('自检页文案与探针实现一致', () => {
  const page = readSource('../ui/pages/SelfCheckPage.tsx')
  const probes = readSource('./probes.ts')

  it('页面上的目录名来自与探针共用的常量，而不是手写的一份', () => {
    // 手写字符串就是"两处各写一份"，探针搬目录时文案会留在原地骗人
    expect(page).toContain('SELFCHECK_DIR_SUFFIX')
    expect(page).not.toContain('__selfcheck')
  })

  it('文案说清了旁路目录与"跑完即删"', () => {
    expect(page).toContain('旁路目录')
    expect(page).toContain('跑完即删')
  })

  it('探针源码里不再有写进真实工作区的 __probe 路径', () => {
    expect(probes).not.toContain('__probe')
  })
})
