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
    await this.remove(t)
    const file = this.files.get(f)
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
