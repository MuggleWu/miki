// FileStore 的内存实现：只用于测试（node 里跑移动版 workspace 的全部语义，不需要真机/模拟器）。
// 语义刻意与 Capacitor 实现对齐：不存在返回 null / 空数组、remove 与 mkdir 幂等、rename 覆盖目标。
import { type DirEntry, type FileStat, type FileStore, normalizeRelPath, parentDir } from './types'

interface MemFile {
  data: string
  mtimeMs: number
}

export class MemoryFileStore implements FileStore {
  private files = new Map<string, MemFile>()
  private dirs = new Set<string>([''])
  /** 可控时钟，便于断言 mtime / 重载逻辑 */
  private clock: () => number
  /** 每次操作记一笔，测试里断言「一次答题只落一次盘」这类约束 */
  readonly calls: string[] = []

  constructor(clock: () => number = () => Date.now()) {
    this.clock = clock
  }

  /** 直接铺一份初始内容（测试准备用，不记 calls） */
  seed(path: string, data: string): void {
    const p = normalizeRelPath(path)
    const dir = parentDir(p)
    if (dir) this.mkdirSync(dir)
    this.files.set(p, { data, mtimeMs: this.clock() })
  }

  private mkdirSync(dir: string): void {
    const parts = dir.split('/').filter(Boolean)
    let acc = ''
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part
      this.dirs.add(acc)
    }
  }

  async readText(path: string): Promise<string | null> {
    const f = this.files.get(normalizeRelPath(path))
    this.calls.push(`read:${normalizeRelPath(path)}`)
    return f ? f.data : null
  }

  async writeText(path: string, data: string): Promise<void> {
    const p = normalizeRelPath(path)
    this.calls.push(`write:${p}`)
    this.mkdirSync(parentDir(p))
    this.files.set(p, { data, mtimeMs: this.clock() })
  }

  async appendText(path: string, data: string): Promise<void> {
    const p = normalizeRelPath(path)
    this.calls.push(`append:${p}`)
    this.mkdirSync(parentDir(p))
    const prev = this.files.get(p)
    this.files.set(p, { data: (prev?.data ?? '') + data, mtimeMs: this.clock() })
  }

  async stat(path: string): Promise<FileStat | null> {
    const p = normalizeRelPath(path)
    const f = this.files.get(p)
    if (f) return { size: byteLength(f.data), mtimeMs: f.mtimeMs }
    if (this.dirs.has(p)) return { size: 0, mtimeMs: 0 }
    return null
  }

  async list(dir: string): Promise<DirEntry[]> {
    const d = normalizeRelPath(dir)
    const prefix = d ? `${d}/` : ''
    const out: DirEntry[] = []
    for (const [p, f] of this.files) {
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length)
      if (rest.includes('/')) continue
      out.push({ name: rest, type: 'file', size: byteLength(f.data), mtimeMs: f.mtimeMs })
    }
    for (const child of this.dirs) {
      if (!child.startsWith(prefix) || child === d) continue
      const rest = child.slice(prefix.length)
      if (rest.includes('/')) continue
      out.push({ name: rest, type: 'directory', size: 0, mtimeMs: 0 })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  async mkdir(dir: string): Promise<void> {
    this.calls.push(`mkdir:${normalizeRelPath(dir)}`)
    this.mkdirSync(normalizeRelPath(dir))
  }

  async remove(path: string): Promise<void> {
    const p = normalizeRelPath(path)
    this.calls.push(`remove:${p}`)
    this.files.delete(p)
    const prefix = `${p}/`
    for (const key of [...this.files.keys()]) if (key.startsWith(prefix)) this.files.delete(key)
    for (const key of [...this.dirs]) if (key === p || key.startsWith(prefix)) this.dirs.delete(key)
  }

  async rename(from: string, to: string): Promise<void> {
    const f = normalizeRelPath(from)
    const t = normalizeRelPath(to)
    this.calls.push(`rename:${f}->${t}`)
    // 源既不是文件也不是已知目录：真机的 Filesystem.rename 会抛错。这里必须先判后动——
    // 少了这道判断，源缺失会落进下面的「目录改名」分支，静默造出一个空目标（幻影文件）：
    // 看起来成功了、实际什么都没搬，依赖「rename 失败要报错」的用例在 node 里就会假通过
    // （例如整份重写的文件走 tmp + rename：tmp 缺失这条路径测不出来）。
    // 顺序上先判源、再删目标：真机是先删目标再抛错（源缺失时会连老目标一起删掉），
    // 内存替身不复制这个破坏性细节，只对齐「源缺失必须报错、且不留下目标」这条契约。
    const file = this.files.get(f)
    if (!file && !this.dirs.has(f)) throw new Error(`rename: 源不存在：${f}`)
    await this.remove(t)
    if (file) {
      this.files.delete(f)
      this.mkdirSync(parentDir(t))
      this.files.set(t, file)
      return
    }
    // 目录改名：整体平移前缀
    const prefix = `${f}/`
    const moved = [...this.files.entries()].filter(([k]) => k.startsWith(prefix))
    for (const [k, v] of moved) {
      this.files.delete(k)
      this.mkdirSync(parentDir(`${t}/${k.slice(prefix.length)}`))
      this.files.set(`${t}/${k.slice(prefix.length)}`, v)
    }
    for (const d of [...this.dirs]) if (d === f || d.startsWith(prefix)) this.dirs.delete(d)
    this.mkdirSync(t)
  }

  async uri(path: string): Promise<string> {
    return `memory:///${normalizeRelPath(path)}`
  }
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}
