// 文件层出口：移动端其余代码只 import 这里，不直接碰插件或内存实现。
export { CapacitorFileStore } from './capacitor-fs'
export { MemoryFileStore } from './memory-fs'
export { normalizeRelPath, parentDir, readTexts } from './types'
export type { DirEntry, FileStat, FileStore } from './types'
