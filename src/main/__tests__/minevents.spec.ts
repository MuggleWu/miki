import { describe, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { WorkspaceService } from '../workspace'

// 事件不驻留回归验收（L1 架构约束）：默认跳过，MIKI_BENCH=1 时实测。
// 运行：MIKI_BENCH=1 NODE_OPTIONS=--expose-gc npx vitest run src/main/__tests__/minevents.spec.ts
// 验证 100 万历史事件重启后内存不随事件数线性增长（旧架构此场景事件驻留约 1.35GB）。
// 注：需 --expose-gc 才能排除 parse 垃圾干扰；无 gc 时退化为仅断言 events.length === 0。
describe.skipIf(process.env.MIKI_BENCH !== '1')('历史事件地雷拆除（MIKI_BENCH=1）', () => {
  it('100 万事件重启：events 不驻留、启动线性于卡片数', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miki-mine-'))
    const ws = new WorkspaceService()
    ws.init(dir)
    const deck = ws.addDeck('地雷验证')
    const CARDS = 10_000
    const EVENTS = 1_000_000
    const cards = ws.addCards(
      deck.id,
      Array.from({ length: CARDS }, (_, i) => ({ front: `正面 ${i}`, back: `背面 ${i}` }))
    )
    // 程序化生成 100 万 answer 事件（过去 365 天均匀分布，模拟多年重度使用）
    const logDir = path.join(dir, 'review-log')
    fs.mkdirSync(logDir, { recursive: true })
    const now = Date.now()
    const DAY = 86_400_000
    // 分批流式写（避免 100 万行字符串数组整块驻留干扰内存测量）
    const lineOf = (i: number): string => {
      const c = cards[i % CARDS]
      const t = now - (i % 365) * DAY - (i % 86_400_000)
      const before = { state: 2 as const, step: null, stability: 5, difficulty: 5, due: t - DAY, lastReview: t - DAY }
      const after = { state: 2 as const, step: null, stability: 6, difficulty: 5, due: t + 3 * DAY, lastReview: t }
      return JSON.stringify({ t, action: 'answer', cardId: c.id, deckId: deck.id, rating: (i % 4) + 1, before, after })
    }
    const fd = fs.openSync(path.join(logDir, '000001.ndjson'), 'w')
    let buf: string[] = []
    for (let i = 0; i < EVENTS; i++) {
      buf.push(lineOf(i))
      if (buf.length === 10_000) {
        fs.writeSync(fd, buf.join('\n') + '\n')
        buf = []
      }
    }
    if (buf.length) fs.writeSync(fd, buf.join('\n') + '\n')
    fs.closeSync(fd)

    const gc = (globalThis as { gc?: () => void }).gc
    gc?.()
    const ws2 = new WorkspaceService()
    const t0 = performance.now()
    ws2.init(dir)
    const ms = performance.now() - t0
    gc?.()
    gc?.()
    const heap = process.memoryUsage().heapUsed / 1024 / 1024
    const rss = process.memoryUsage().rss / 1024 / 1024
    const card = ws2.getCard(cards[0].id)!
    console.log(`100 万事件重启：${(ms / 1000).toFixed(1)}s，heapUsed ${heap.toFixed(0)}MB，rss ${rss.toFixed(0)}MB`)
    console.log(`events 驻留：${ws2.events.length} 条（期望 0）；抽查卡 reps=${card.reps}（期望 250）`)
    // 旧架构此场景事件驻留 ≈ 100 万 × 1.35KB ≈ 1.35GB；未驻留则 heapUsed 远低于此
    if (heap > 500) throw new Error(`事件疑似驻留内存：heapUsed ${heap.toFixed(0)}MB > 500MB`)
    if (ws2.events.length !== 0) throw new Error(`events 应为 0，实际 ${ws2.events.length}`)
    fs.rmSync(dir, { recursive: true, force: true })
  }, 300_000)
})
