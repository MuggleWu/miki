// 真实工作区对账：拿桌面端实际在用的 miki-base 目录跑一遍移动端加载器，
// 与**桌面端自己**在同一份数据上的输出逐牌组比对（M1 出口标准：内存态与桌面端一致）。
//
// 两份实现在同一个测试里跑，所以仓库里不需要留任何真实数据——牌组 id、卡片数都不落盘，
// 期望值就是桌面端当场算出来的结果。这也是对"基准"这件事的修正：之前把基准写死在测试里
// （先是自己另写的一份实现、后来是抄下来的桌面端数字），两种都会把基准的偏差当成被测实现的 bug。
//
// 默认跳过：路径指向本机真实学习数据，不进仓库、不进 CI。
// 手动跑：MIKI_REAL_WS=/path/to/miki-base npx vitest run src/mobile/real-workspace.spec.ts
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MobilePaths } from './paths'
import { MobileWorkspace } from './workspace'
import type { DirEntry, FileStat, FileStore } from './fs'
// 桌面端的唯一写入口（只 import node 内置模块与本地模块，能在 node 环境直接跑）
import { WorkspaceService } from '@desktop/main/workspace'

/** 只读的 node 文件系统实现（写操作直接抛错：对账过程不该改真实数据） */
class NodeReadOnlyStore implements FileStore {
  constructor(private readonly root: string) {}

  async readText(path: string): Promise<string | null> {
    try {
      return await readFile(join(this.root, path), 'utf8')
    } catch {
      return null
    }
  }

  async stat(path: string): Promise<FileStat | null> {
    try {
      const s = await stat(join(this.root, path))
      return { size: s.size, mtimeMs: s.mtimeMs }
    } catch {
      return null
    }
  }

  async list(dir: string): Promise<DirEntry[]> {
    try {
      const entries = await readdir(join(this.root, dir), { withFileTypes: true })
      const out: DirEntry[] = []
      for (const e of entries) {
        const s = e.isDirectory() ? null : await stat(join(this.root, dir, e.name))
        out.push({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          size: s?.size ?? 0,
          mtimeMs: s?.mtimeMs ?? 0
        })
      }
      return out
    } catch {
      return []
    }
  }

  /** init() 会幂等地 mkdir 一次工作区目录；真实目录已经在了，给个 no-op 即可 */
  async mkdir(): Promise<void> {}
  async writeText(): Promise<void> {
    throw new Error('对账用的是只读文件系统')
  }
  async appendText(): Promise<void> {
    throw new Error('对账用的是只读文件系统')
  }
  async remove(): Promise<void> {
    throw new Error('对账用的是只读文件系统')
  }
  async rename(): Promise<void> {
    throw new Error('对账用的是只读文件系统')
  }
  async uri(path: string): Promise<string> {
    return join(this.root, path)
  }
}

/** 数 review-log 里的事件行（非空行）：移动端重放到的行数应当与之相等 */
async function countLogLines(ws: string): Promise<number> {
  const dir = join(ws, 'review-log')
  let n = 0
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.ndjson')) continue
    const text = await readFile(join(dir, name), 'utf8')
    n += text.split('\n').filter((l) => l.trim().length > 0).length
  }
  return n
}

const REAL_WS = process.env.MIKI_REAL_WS
let tmpRoot: string | null = null

afterAll(async () => {
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true })
})

describe.skipIf(!REAL_WS)('真实工作区对账（M1 出口标准）', () => {
  it('牌组数 / 各牌组卡片数 / 事件数与桌面端一致', async () => {
    // 桌面端要在副本上跑：init() 会写 config.json 与 stats.json，不能碰真实目录
    tmpRoot = await mkdtemp(join(tmpdir(), 'miki-parity-'))
    const copyDir = join(tmpRoot, basename(REAL_WS!))
    await cp(REAL_WS!, copyDir, { recursive: true })
    const desktop = new WorkspaceService()
    desktop.init(copyDir)

    // 移动端：文件层的根是工作区的**父目录**（MobilePaths 的相对路径里已含工作区目录名）
    const store = new NodeReadOnlyStore(dirname(REAL_WS!))
    const mobile = new MobileWorkspace(store, new MobilePaths(basename(REAL_WS!)))
    await mobile.init()

    // 牌组表：id → 总数。两边整张表都要相同——总数相同但分布错了才是真隐患
    const tableOf = (infos: { id: string; counts: { total: number } }[]): Record<string, number> =>
      Object.fromEntries(infos.map((d) => [d.id, d.counts.total]))
    const desktopTable = tableOf(desktop.deckInfos())
    const mobileTable = tableOf(mobile.deckInfos())

    expect(Object.keys(mobileTable).length).toBeGreaterThan(0) // 空工作区不算通过
    expect(mobileTable).toEqual(desktopTable)

    // 同口径对账：累计答题数、今日答题数（桌面端没有"加载耗时"这类为移动端做的仪表）
    expect(mobile.totalAnswered()).toBe(desktop.totalAnswered())
    expect(mobile.todayCount()).toBe(desktop.todayCount())
    // 重放吃到的行数由本测试自己数（坏行两边都不该有）
    expect(mobile.loadTimingReport()?.eventCount).toBe(await countLogLines(REAL_WS!))
    expect(mobile.damageReport().damagedLines).toBe(desktop.damageReport().damagedLines)
    expect(mobile.damageReport().truncatedFiles).toHaveLength(0)
  })
})
