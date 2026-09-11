// 设备自检：把「M0 存储假设」和「M1 数据层」在**真机的 Capacitor 文件系统**上跑一遍。
//
// 为什么要有这一层：Node 上的单元测试跑的是内存 FileStore，它证明的是逻辑自洽；
// 真机的插件语义（路径是否可写、append 是否真的追加、stat 的 size 语义、递归删除）
// 只能在设备上验。两者都过，才敢说数据层可用。
//
// 三条纪律：
// 1. 全部在 `<root>__selfcheck/` 这个独立目录里做，**绝不碰真实工作区**；
// 2. 数据全是当场合成的假数据（miki 是公开仓库，真实学习数据不得出现在任何日志里）；
// 3. 跑完删目录，跑第二次不受第一次影响。
import type { FileStore } from './fs'
import { MobilePaths } from './paths'
import { MobileWorkspace } from './workspace'
import type { ProbeResult } from './probes'
import type { Card } from '@shared/types'

/** 自检用的独立目录名（与真实工作区完全隔离） */
export const SELFCHECK_DIR_SUFFIX = '__selfcheck'

const DECK_ID = 'probe-deck'
const now = 1_700_000_000_000

function fakeCardRow(id: string, front: string, t: number): string {
  return JSON.stringify({
    id,
    front,
    back: `合成卡背 ${id}`,
    createdAt: t,
    updatedAt: t,
    deletedAt: null,
    suspended: false
  })
}

/** 只比「真理字段」：tie/seqApplied 是运行期索引字段，重载后本来就会重算 */
function truth(c: Card | null): string {
  if (!c) return 'null'
  return JSON.stringify({
    id: c.id,
    deckId: c.deckId,
    front: c.front,
    back: c.back,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    deletedAt: c.deletedAt,
    suspended: c.suspended,
    fsrs: c.fsrs,
    reps: c.reps,
    lapses: c.lapses
  })
}

/** 探针 5：M1 数据层在真机文件系统上的「写入 → 重载重放」往返一致性 */
export async function probeWorkspaceRoundTrip(store: FileStore, base: string): Promise<ProbeResult> {
  const root = `${base}${SELFCHECK_DIR_SUFFIX}`
  const paths = new MobilePaths(root)
  const detail: string[] = []
  const ok = (cond: boolean, label: string): boolean => {
    detail.push(`${cond ? '✓' : '✗'} ${label}`)
    return cond
  }
  try {
    await store.remove(root)
    await store.mkdir(`${root}/cards`)
    await store.mkdir(`${root}/review-log`)
    await store.writeText(
      paths.decksFile(),
      JSON.stringify([{ id: DECK_ID, name: '自检牌组', order: 0, createdAt: now, deletedAt: null }])
    )
    await store.writeText(
      paths.deckCardsFile(DECK_ID),
      fakeCardRow('p1', '自检卡一', now) + '\n' + fakeCardRow('p2', '自检卡二', now + 1) + '\n'
    )

    const ws = new MobileWorkspace(store, paths)
    await ws.init()
    let pass = true
    pass = ok(ws.cards.size === 2, `加载 2 张合成卡（实际 ${ws.cards.size}）`) && pass
    pass = ok(ws.deckInfos()[0]?.counts.new === 2, `新卡计数=2（实际 ${ws.deckInfos()[0]?.counts.new}）`) && pass

    // 答题 → 撤销 → 再答题
    await ws.answer('p1', 3, 900)
    pass = ok(ws.todayCount() === 1, `答题后今日计数=1（实际 ${ws.todayCount()}）`) && pass
    await ws.undo()
    pass = ok(ws.todayCount() === 0, `撤销后今日计数=0（实际 ${ws.todayCount()}）`) && pass

    await ws.answer('p1', 4)
    const afterAnswer = truth(ws.getCard('p1'))
    pass = ok(ws.getCard('p1')!.fsrs !== null, '答题后该卡有调度状态') && pass

    // 编辑卡片（走 delta 追加），再整体重载
    await ws.updateCard('p2', { front: '自检卡二（改过）' })
    const afterEdit = truth(ws.getCard('p2'))

    const ws2 = new MobileWorkspace(store, paths)
    await ws2.init()
    pass = ok(truth(ws2.getCard('p1')) === afterAnswer, '重载后 p1 调度状态与作答时逐字段一致') && pass
    pass = ok(truth(ws2.getCard('p2')) === afterEdit, '重载后 p2 编辑结果一致（delta 生效）') && pass
    pass = ok(ws2.todayCount() === 1, `重载后今日计数=1（实际 ${ws2.todayCount()}）`) && pass
    pass = ok(ws2.getCard('p2')!.fsrs === null, 'p2 未被误加调度状态') && pass

    // 新增卡片 → 追加基文件 → 重载可见
    const added = await ws2.addCard(DECK_ID, '自检新卡', '合成卡背')
    const ws3 = new MobileWorkspace(store, paths)
    await ws3.init()
    pass = ok(ws3.getCard(added.id) !== null, '新增卡片经重载后仍在') && pass

    const base = (await store.readText(paths.deckCardsFile(DECK_ID))) ?? ''
    pass = ok(base.trim().split('\n').length === 3, `基文件 3 行（实际 ${base.trim().split('\n').length}）`) && pass

    await store.remove(root)
    const gone = await store.stat(root)
    pass = ok(gone === null, '自检目录已清理干净') && pass

    detail.unshift(`自检目录：${root}（跑完已删除）`)
    return {
      id: 'workspace',
      title: '探针 5：M1 数据层「写入 → 重载重放」往返一致性',
      status: pass ? 'pass' : 'fail',
      detail,
      note: pass ? undefined : '有断言不成立，逐条对照上面的 ✓/✗'
    }
  } catch (e) {
    try {
      await store.remove(root)
    } catch {
      // 清理失败不掩盖原始异常
    }
    return {
      id: 'workspace',
      title: '探针 5：M1 数据层「写入 → 重载重放」往返一致性',
      status: 'fail',
      detail,
      note: `抛异常：${e instanceof Error ? e.message : String(e)}`
    }
  }
}

/** 自检入口：跑全部不需要凭据的探针，并把结果打进 console（Capacitor 会转发进 logcat） */
export async function runDeviceSelfCheck(
  store: FileStore,
  base: string,
  probes: { storage: () => Promise<ProbeResult>; perf: () => Promise<ProbeResult> }
): Promise<ProbeResult[]> {
  const out: ProbeResult[] = []
  for (const run of [probes.storage, probes.perf, () => probeWorkspaceRoundTrip(store, base)]) {
    try {
      out.push(await run())
    } catch (e) {
      out.push({
        id: 'crash',
        title: '自检项抛异常',
        status: 'fail',
        detail: [],
        note: e instanceof Error ? e.message : String(e)
      })
    }
  }
  for (const r of out) {
    console.log(`[miki-selfcheck] ${r.status.toUpperCase()} ${r.id} :: ${r.title}`)
    for (const d of r.detail) console.log(`[miki-selfcheck]   ${d}`)
    if (r.note) console.log(`[miki-selfcheck]   note: ${r.note}`)
  }
  console.log(`[miki-selfcheck] SUMMARY ${out.map((r) => `${r.id}=${r.status}`).join(' ')}`)
  return out
}
