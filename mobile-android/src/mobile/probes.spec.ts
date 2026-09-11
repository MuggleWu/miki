// 探针逻辑本身的测试：两条探针都在内存实现上跑一遍。
// 这样「探针代码写错了」和「设备上真的不行」不会混在一起——先在这里证明探针是对的。
import { describe, expect, it } from 'vitest'
import { MemoryFileStore } from './fs'
import { probeNdjsonPerf, probePrivateStorage } from './probes'

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
    // 跑完不留垃圾
    expect(await store.stat('miki-base/__probe')).toBeNull()
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
})

describe('探针 2：NDJSON 追加耗时', () => {
  it('合成数据规模落在 MB 级，且给出 avg/p95', async () => {
    const store = new MemoryFileStore()
    const r = await probeNdjsonPerf(store, 'miki-base', { mb: 2, rounds: 10 })
    expect(r.status).toBe('pass')
    expect(r.detail.some((d) => /\d+ 行 \/ 2\.\d+ MB/.test(d))).toBe(true)
    expect(r.detail.some((d) => d.includes('p95'))).toBe(true)
    expect(await store.stat('miki-base/__probe')).toBeNull()
  })
})
