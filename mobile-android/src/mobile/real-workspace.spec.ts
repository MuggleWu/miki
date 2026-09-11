// 真实工作区对账：拿桌面端实际在用的 miki-base 目录跑一遍移动端加载器，
// 与**桌面端自己**在同一份数据上的输出逐牌组比对。这是 M1 出口标准
// 「内存态与桌面端一致」的可执行版本。
//
// 为什么基准是桌面端、而不是"另外写一份实现"：这次先用 Python 按 ndjson 语义独立重算当基准，
// 结果移动端少 9 张卡，一度看着像移动端的 bug；把桌面端跑起来才发现桌面端也是 6657——
// 不一致的是那份 Python（它没复刻 ScheduleIndex 的计数口径）。基准选错，会把基准的偏差
// 当成被测实现的 bug。
//
// 默认跳过：这个路径指向 本机真实工作区，不进仓库、不进 CI。
// 手动跑：MIKI_REAL_WS=/path/to/miki-base npx vitest run src/mobile/real-workspace.spec.ts
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MobilePaths } from './paths'
import { MobileWorkspace } from './workspace'
import type { DirEntry, FileStat, FileStore } from './fs'

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
        let size = 0
        let mtimeMs = 0
        if (!e.isDirectory()) {
          const s = await stat(join(this.root, dir, e.name))
          size = s.size
          mtimeMs = s.mtimeMs
        }
        out.push({ name: e.name, type: e.isDirectory() ? 'directory' : 'file', size, mtimeMs })
      }
      return out
    } catch {
      return []
    }
  }

  async writeText(): Promise<void> {
    throw new Error('对账用的是只读文件系统')
  }
  async appendText(): Promise<void> {
    throw new Error('对账用的是只读文件系统')
  }
  /** init() 会幂等地 mkdir 一次工作区目录；真实目录已经在了，给个 no-op 即可 */
  async mkdir(): Promise<void> {}
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

const REAL_WS = process.env.MIKI_REAL_WS

describe.skipIf(!REAL_WS)('真实工作区对账（M1 出口标准）', () => {
  it('牌组数 / 各牌组卡片数 / 事件数与桌面端一致', async () => {
    // 文件层的根是工作区的**父目录**：MobilePaths 生成的相对路径里已经含工作区目录名
    const store = new NodeReadOnlyStore(dirname(REAL_WS!))
    const ws = new MobileWorkspace(store, new MobilePaths(basename(REAL_WS!)))
    await ws.init()

    const infos = ws.deckInfos()
    // 基准不是"另外写一份实现"，而是**桌面端自己在同一份数据上的输出**（M1 出口标准原话
    // 就是"内存态与桌面端一致"）。期望值取自：
    //   cd miki && cp -R <真实工作区> /tmp/ws-copy
    //   在 node 里 new WorkspaceService().init('/tmp/ws-copy') 后打印 deckInfos()
    // 桌面端：33bad029 1108 / b328a277 468 / 28a8b109 518 / c4c13ca5 43 /
    //        c9aa2cd4 856 / ad161894 1 / f9b0445a 3663（合计 6657）
    expect(infos).toHaveLength(7) // decks.json 里 10 条，其中 3 条软删
    expect(ws.cardCount()).toBe(6716) // 含 3 个软删牌组里的卡（内存态保留，只是不计入牌组表）
    const perDeck = Object.fromEntries(infos.map((d) => [d.id, d.counts.total]))
    expect(perDeck).toEqual({
      '33bad029-c2b6-4424-b0bc-57bc390f432a': 1108,
      'b328a277-67f0-4b19-83c1-6bfd90dd64bc': 468,
      '28a8b109-f74e-4981-821a-fd2a7ba61186': 518,
      'c4c13ca5-8b71-4ec6-9494-61848527d3d9': 43,
      'c9aa2cd4-3759-42e2-80bd-e01c1a403b7f': 856,
      'ad161894-e141-44b9-9488-5e72eb066509': 1,
      'f9b0445a-51ad-4687-afa9-f3cffc199c7b': 3663
    })
    expect(infos.reduce((n, d) => n + d.counts.total, 0)).toBe(6657)
    expect(ws.loadTimingReport()?.eventCount).toBe(643)
    expect(ws.damageReport().damagedLines).toBe(0)
    expect(ws.damageReport().truncatedFiles).toHaveLength(0)
  })
})
