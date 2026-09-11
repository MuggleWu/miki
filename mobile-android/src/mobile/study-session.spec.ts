// 学习会话控制器测试：出卡 → 显示答案 → 评级 → 下一张 → 撤销 的状态机与耗时口径。
import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryFileStore } from './fs'
import { MobilePaths } from './paths'
import { MobileWorkspace } from './workspace'
import { StudySession } from './study-session'
import { MAX_ANSWER_MS } from '@shared/format'

const ROOT = 'miki-base'
const DECK = 'd1'

function seed(fs: MemoryFileStore): void {
  fs.seed(`${ROOT}/decks.json`, JSON.stringify([{ id: DECK, name: '自检', order: 0, createdAt: 1, deletedAt: null }]))
  const rows = [1, 2].map((n) =>
    JSON.stringify({
      id: `c${n}`,
      front: `卡面 ${n}`,
      back: `卡背 ${n}`,
      createdAt: n,
      updatedAt: n,
      deletedAt: null,
      suspended: false
    })
  )
  fs.seed(`${ROOT}/cards/${DECK}.ndjson`, rows.join('\n') + '\n')
}

/** 读当前月份的 review-log 事件（不存在时返回空数组） */
async function logEvents(fs: MemoryFileStore): Promise<Record<string, unknown>[]> {
  const text = (await fs.readText(new MobilePaths(ROOT).logFile(Date.now()))) ?? ''
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe('学习会话', () => {
  let fs: MemoryFileStore
  let ws: MobileWorkspace
  let session: StudySession

  beforeEach(async () => {
    fs = new MemoryFileStore()
    seed(fs)
    ws = new MobileWorkspace(fs, new MobilePaths(ROOT))
    await ws.init()
    session = new StudySession(ws, DECK)
  })

  it('开始时出第一张卡、未显示答案、剩余数与今日计数正确', () => {
    const s = session.start()
    expect(s.card).not.toBeNull()
    expect(s.revealed).toBe(false)
    expect(s.remaining).toBe(2)
    expect(s.todayCount).toBe(0)
    expect(s.preview).toBeNull()
    expect(s.undoable).toBe(0)
  })

  it('未显示答案时评级不生效（防止误触把没看的卡评掉）', async () => {
    session.start()
    const s = await session.rate(3)
    expect(s.revealed).toBe(false)
    expect(await logEvents(fs)).toHaveLength(0)
  })

  it('显示答案后给出四档预览，且四档间隔递增', () => {
    session.start()
    const s = session.reveal()
    expect(s.revealed).toBe(true)
    expect(s.preview).toHaveLength(4)
    const dues = s.preview!.map((p) => p.due)
    expect(dues[0]).toBeLessThanOrEqual(dues[1])
    expect(dues[1]).toBeLessThanOrEqual(dues[2])
    expect(dues[2]).toBeLessThanOrEqual(dues[3])
    expect(s.preview![0].label).toBeTruthy()
  })

  it('显示答案幂等（重复点按不改变预览）', () => {
    session.start()
    const a = session.reveal()
    const b = session.reveal()
    expect(b.preview).toEqual(a.preview)
  })

  it('评级：落盘一条 answer 事件，并立刻出下一张卡', async () => {
    session.start()
    const first = session.get().card!.id
    session.reveal()
    const s = await session.rate(3)
    expect(await logEvents(fs)).toHaveLength(1)
    expect((await logEvents(fs))[0]).toMatchObject({ action: 'answer', cardId: first, rating: 3 })
    expect(s.todayCount).toBe(1)
    expect(s.revealed).toBe(false)
    expect(s.card).not.toBeNull()
    expect(s.card!.id).not.toBe(first) // 换到下一张
  })

  it('答题耗时按「上屏到评级」计算，并封顶 MAX_ANSWER_MS', async () => {
    const t0 = 1_700_000_000_000
    session.start(t0)
    session.reveal(t0)
    await session.rate(3, t0 + 4200)
    expect((await logEvents(fs))[0].durationMs).toBe(4200)

    // 第二次：待机 8 小时 → 封顶 5 分钟
    const t1 = t0 + 10_000
    session.start(t1)
    session.reveal(t1)
    await session.rate(3, t1 + 8 * 3600_000)
    expect((await logEvents(fs))[1].durationMs).toBe(MAX_ANSWER_MS)
  })

  it('撤销：回到上一张卡、今日计数回退，再评一次能继续', async () => {
    session.start()
    const first = session.get().card!.id
    session.reveal()
    await session.rate(2)
    const s = await session.undo()
    expect(s.flash).toBe('已撤销')
    expect(s.card!.id).toBe(first)
    expect(s.revealed).toBe(false)
    expect(s.todayCount).toBe(0)
    expect(s.undoable).toBe(0)

    session.reveal()
    const s2 = await session.rate(4)
    expect(s2.todayCount).toBe(1)
    expect((await logEvents(fs)).map((e) => e.action)).toEqual(['answer', 'undo', 'answer'])
  })

  it('没有可撤销操作时给出提示而不是抛错', async () => {
    session.start()
    const s = await session.undo()
    expect(s.flash).toBe('没有可撤销的操作')
    expect(s.todayCount).toBe(0)
  })

  it('学完两张卡后 card 为 null，剩余数为 0', async () => {
    session.start()
    session.reveal()
    await session.rate(4)
    session.reveal()
    const s = await session.rate(4)
    expect(s.remaining).toBe(0)
    expect(s.card).toBeNull()
    expect(s.todayCount).toBe(2)
  })

  it('卡被删除后刷新会话：当前卡清空并给出提示', async () => {
    session.start()
    const id = session.get().card!.id
    await ws.deleteCard(id)
    const s = session.refreshCard()
    expect(s.flash).toBe('卡片已删除')
    expect(s.card?.id).not.toBe(id)
  })

  it('编辑当前卡后刷新会话：屏幕上换上新内容', async () => {
    session.start()
    const id = session.get().card!.id
    await ws.updateCard(id, { front: '改过的卡面' })
    const s = session.refreshCard()
    expect(s.card!.id).toBe(id)
    expect(s.card!.front).toBe('改过的卡面')
  })
})

describe('会话刷新（同步拉取 / 回到前台重载之后）', () => {
  let fs: MemoryFileStore
  let ws: MobileWorkspace
  let session: StudySession

  beforeEach(async () => {
    fs = new MemoryFileStore()
    seed(fs)
    ws = new MobileWorkspace(fs, new MobilePaths(ROOT))
    await ws.init()
    session = new StudySession(ws, DECK)
    session.start()
  })

  it('不换卡，但卡面内容跟着新数据走', async () => {
    const id = session.get().card!.id
    const before = session.get().card!.front
    // 别机改过这张卡的正文（写进 delta，重载后生效）
    fs.seed(
      `${ROOT}/cards/${DECK}.delta.ndjson`,
      JSON.stringify({
        id,
        front: '别机改过的正面',
        back: 'x',
        createdAt: 1,
        updatedAt: 9_999_999_999_999,
        deletedAt: null,
        suspended: false
      }) + '\n'
    )
    await ws.reload()
    const s = session.refresh()
    expect(s.card!.id).toBe(id) // 不换卡：正在看的这张不动
    expect(s.card!.front).toBe('别机改过的正面') // 但内容必须是新的
    expect(s.card!.front).not.toBe(before)
  })

  it('可撤销数跟着走：重载会重建会话日志，页面不能还显示旧的可撤销数', async () => {
    session.reveal() // rate 要求先显示答案（与真机上的操作顺序一致）
    await session.rate(3)
    expect(session.get().undoable).toBe(1)
    await ws.reload() // 同步拉取后就是这样：撤销栈被重放重建，stack 空了
    expect(session.refresh().undoable).toBe(0)
  })

  it('当前这张被删/暂停了才重挑一张', async () => {
    const id = session.get().card!.id
    await ws.setCardSuspended(id, true)
    const s = session.refresh()
    expect(s.card?.id).not.toBe(id)
  })
})
