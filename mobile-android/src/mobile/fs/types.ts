// 移动端文件层契约：所有路径都是相对「工作区根」的 POSIX 风格相对路径（用 / 分隔、不带前导斜杠）。
//
// 为什么要有这层抽象：桌面端 WorkspaceService 直接调 node:fs 同步 API，移动端跑在 WebView 里
// 只能走 Capacitor 的异步 Filesystem 插件。把「读写什么」与「怎么读写」分开之后，
// 移动版 workspace 的全部语义都能在 node 里用内存实现跑测试（不需要真机）。

export interface FileStat {
  /** 字节数 */
  size: number
  /** 最后修改时间（ms epoch） */
  mtimeMs: number
}

export interface DirEntry extends FileStat {
  name: string
  type: 'file' | 'directory'
}

export interface FileStore {
  /** 读文本文件；文件不存在返回 null（不抛错） */
  readText(path: string): Promise<string | null>
  /** 整文件覆盖写（父目录缺失时自动创建） */
  writeText(path: string, data: string): Promise<void>
  /** 追加写（文件不存在则创建；父目录缺失时自动创建） */
  appendText(path: string, data: string): Promise<void>
  /** 文件/目录信息；不存在返回 null */
  stat(path: string): Promise<FileStat | null>
  /** 目录条目（不递归）；目录不存在返回空数组 */
  list(dir: string): Promise<DirEntry[]>
  /** 递归创建目录（已存在则 no-op） */
  mkdir(dir: string): Promise<void>
  /** 删除文件或目录（不存在则 no-op） */
  remove(path: string): Promise<void>
  /** 重命名；目标已存在时先删目标（与桌面端 renameSync 覆盖语义对齐） */
  rename(from: string, to: string): Promise<void>
  /** 真实绝对路径/URI——排查数据落在哪、以及备份规则要排除哪个目录时用 */
  uri(path: string): Promise<string>
}

/** 路径规范化：去掉重复斜杠、前导斜杠与结尾斜杠（相对路径才能拼到 Directory.Data 下） */
export function normalizeRelPath(path: string): string {
  const trimmed = path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  const parts = trimmed.split('/').filter((p) => p !== '' && p !== '.')
  return parts.join('/')
}

/** 取父目录（顶层返回空串） */
export function parentDir(path: string): string {
  const p = normalizeRelPath(path)
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

/**
 * 并发读取多个文件（限流），返回 path → 内容（不存在为 null）。
 *
 * 存在的理由：在这台设备上每次读文件都是一次 JS ↔ 原生的桥调用，串行发起时
 * 每个往返约 9ms。大库（200 个牌组 × 基文件 + delta = 400 次）串行读实测要 1.8–2.0s，
 * 占了整个启动的绝大部分。桥调用本身没有共享状态，并发发起即可；调用方仍按自己的
 * 顺序解析，合并语义不受影响。并发上限默认 16：再多收益趋平（桥是单通道），
 * 但会让低端机的原生线程池排队。
 */
export async function readTexts(
  store: FileStore,
  paths: readonly string[],
  limit = 16
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const path = paths[next++]
      if (out.has(path)) continue
      out.set(path, await store.readText(path))
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, paths.length) }, worker))
  return out
}
