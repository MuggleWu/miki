// NF2 性能基准：默认跳过，不拖慢常规测试；MIKI_BENCH=1 时在临时目录实测核心操作耗时。
// 运行：MIKI_BENCH=1 npx vitest run src/main/__tests__/perf.spec.ts
// 规模：MIKI_BENCH_N（默认 10000 张卡）。逐项耗时用 console.table 输出，仅供人工对比，不做断言阈值。
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, it } from 'vitest'
import { WorkspaceService } from '../workspace'
import type { Rating } from '../../shared/types'

const N = Number(process.env.MIKI_BENCH_N ?? 10_000)
const enabled = process.env.MIKI_BENCH === '1'

describe.skipIf(!enabled)(`性能基准（N=${N}）`, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miki-bench-'))
  const ws = new WorkspaceService()
  const timings: { 操作: string; 耗时ms: string; 吞吐: string }[] = []

  /** 同步计时：全内存 + 同步落盘的写路径都是同步调用 */
  const time = (name: string, n: number, fn: () => void): void => {
    const t0 = performance.now()
    fn()
    const ms = performance.now() - t0
    timings.push({ 操作: name, 耗时ms: ms.toFixed(1), 吞吐: n > 0 ? `${Math.round((n / ms) * 1000)}/s` : '—' })
  }

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('建库并批量导入', () => {
    time('初始化空工作区', 0, () => ws.init(dir))
    const deck = ws.addDeck('基准牌组')
    time(`批量新增 ${N} 张卡（含一次落盘）`, N, () => {
      ws.addCards(
        deck.id,
        Array.from({ length: N }, (_, i) => ({ front: `正面 ${i} 关键词${i % 97}`, back: `背面 ${i}` }))
      )
    })
  })

  it('查询', () => {
    time('全量查询（updatedAt 降序）', N, () => {
      const r = ws.queryCards({ deckId: null, keywords: [], sort: [{ col: 'updatedAt', asc: false }], limit: N })
      if (r.rows.length !== N) throw new Error(`expect ${N} rows, got ${r.rows.length}`)
    })
    time('关键词查询（命中约 1%）', N, () => {
      const r = ws.queryCards({ deckId: null, keywords: ['关键词7'], sort: [], limit: N })
      if (r.rows.length === 0) throw new Error('keyword query hit nothing')
    })
  })

  it(`逐张答题 ${Math.min(1000, N)} 次`, () => {
    const r = ws.queryCards({ deckId: null, keywords: [], sort: [{ col: 'updatedAt', asc: false }], limit: Math.min(1000, N) })
    const ratings: Rating[] = [3, 4, 1, 2]
    time(`答题（调度+追加事件+学习队列）`, r.rows.length, () => {
      r.rows.forEach((row, i) => void ws.answer(row.id, ratings[i % 4], 3500))
    })
  })

  it('重启重放', () => {
    const ws2 = new WorkspaceService()
    time(`重放启动（${N} 卡 + 事件日志）`, N, () => ws2.init(dir))
  })

  it('批量删除与撤销', () => {
    const ids = ws
      .queryCards({ deckId: null, keywords: [], sort: [{ col: 'updatedAt', asc: false }], limit: Math.min(1000, N) })
      .rows.map((r) => r.id)
    time(`批量删除 ${ids.length} 张（含事件与落盘）`, ids.length, () => void ws.deleteCards(ids))
    time('撤销一张', 1, () => ws.undo())
  })

  afterAll(() => {
    // eslint-disable-next-line no-console
    console.table(timings)
  })
})
