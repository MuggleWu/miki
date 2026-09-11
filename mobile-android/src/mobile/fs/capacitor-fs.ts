// FileStore 的 Capacitor 实现：全部落在 Directory.Data（Android 上是 /data/data/<包名>/files）。
//
// 选 Directory.Data 的理由（设计决策 2）：应用私有目录受 Linux UID + SELinux 隔离，
// 其他 App 即便拿到「所有文件访问」也读不到，且本插件对这个目录零权限要求——
// 不申请 MANAGE_EXTERNAL_STORAGE、不走 SAF，Kotlin 代码量为 0。
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { type DirEntry, type FileStat, type FileStore, normalizeRelPath, parentDir } from './types'

/** 插件错误码：文件不存在（见 @capacitor/filesystem README 的错误码表） */
const ERR_NOT_FOUND = 'OS-PLUG-FILE-0008'
/** 目录已存在：并发 mkdir / 重复 mkdir 时会遇到，按幂等处理 */
const ERR_DIR_EXISTS = 'OS-PLUG-FILE-0010'

function errCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 目标不存在 / 已被删除：一律当成「没有」而不是异常，调用方才有干净的 null 语义 */
function isMissing(e: unknown): boolean {
  if (errCode(e) === ERR_NOT_FOUND) return true
  return /does not exist|no such file|not found/i.test(errMessage(e))
}

export class CapacitorFileStore implements FileStore {
  /** 已确认存在的目录，避免每次追加写都 mkdir 一遍（答题落盘在热路径上） */
  private ensuredDirs = new Set<string>([''])

  constructor(private readonly directory: Directory = Directory.Data) {}

  async readText(path: string): Promise<string | null> {
    const p = normalizeRelPath(path)
    try {
      const res = await Filesystem.readFile({ path: p, directory: this.directory, encoding: Encoding.UTF8 })
      // 指定了 encoding 时 data 是字符串（Blob 只在不传 encoding 的二进制路径上出现）
      return typeof res.data === 'string' ? res.data : await res.data.text()
    } catch (e) {
      if (isMissing(e)) return null
      throw e
    }
  }

  async writeText(path: string, data: string): Promise<void> {
    const p = normalizeRelPath(path)
    const dir = parentDir(p)
    await this.ensureDir(dir)
    await Filesystem.writeFile({
      path: p,
      data,
      directory: this.directory,
      encoding: Encoding.UTF8,
      recursive: true
    })
  }

  async appendText(path: string, data: string): Promise<void> {
    const p = normalizeRelPath(path)
    await this.ensureDir(parentDir(p))
    await Filesystem.appendFile({ path: p, data, directory: this.directory, encoding: Encoding.UTF8 })
  }

  async stat(path: string): Promise<FileStat | null> {
    try {
      const info = await Filesystem.stat({ path: normalizeRelPath(path), directory: this.directory })
      return { size: info.size, mtimeMs: info.mtime }
    } catch (e) {
      if (isMissing(e)) return null
      throw e
    }
  }

  async list(dir: string): Promise<DirEntry[]> {
    const d = normalizeRelPath(dir)
    try {
      const res = await Filesystem.readdir({ path: d, directory: this.directory })
      return res.files
        .map((f) => ({ name: f.name, type: f.type, size: f.size, mtimeMs: f.mtime }))
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch (e) {
      if (isMissing(e)) return []
      throw e
    }
  }

  async mkdir(dir: string): Promise<void> {
    await this.ensureDir(normalizeRelPath(dir))
  }

  async remove(path: string): Promise<void> {
    const p = normalizeRelPath(path)
    if (!p) return
    try {
      await Filesystem.deleteFile({ path: p, directory: this.directory })
    } catch (e) {
      if (isMissing(e)) return
      // 目录走不通 deleteFile（插件会以「supplied path is a directory」拒绝）：回退递归删
      await Filesystem.rmdir({ path: p, directory: this.directory, recursive: true })
    }
    for (const key of [...this.ensuredDirs]) if (key === p || key.startsWith(`${p}/`)) this.ensuredDirs.delete(key)
  }

  async rename(from: string, to: string): Promise<void> {
    const f = normalizeRelPath(from)
    const t = normalizeRelPath(to)
    if (f === t) return
    await this.ensureDir(parentDir(t))
    // 覆盖语义对齐桌面端 renameSync：目标存在先删掉，否则 Android 侧会直接报错
    await this.remove(t)
    await Filesystem.rename({ from: f, to: t, directory: this.directory, toDirectory: this.directory })
    for (const key of [...this.ensuredDirs]) if (key === f || key.startsWith(`${f}/`)) this.ensuredDirs.delete(key)
  }

  async uri(path: string): Promise<string> {
    const res = await Filesystem.getUri({ path: normalizeRelPath(path), directory: this.directory })
    return res.uri
  }

  /** 目录实际落在哪（探针与排查用：能回答「数据到底写在哪个绝对路径」） */
  async rootUri(): Promise<string> {
    return this.uri('')
  }

  private async ensureDir(dir: string): Promise<void> {
    if (!dir || this.ensuredDirs.has(dir)) return
    try {
      await Filesystem.mkdir({ path: dir, directory: this.directory, recursive: true })
    } catch (e) {
      if (errCode(e) !== ERR_DIR_EXISTS && !/already exists/i.test(errMessage(e))) throw e
    }
    // 逐级登记，子目录后续写入不再重复 mkdir
    const parts = dir.split('/')
    let acc = ''
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part
      this.ensuredDirs.add(acc)
    }
  }
}
