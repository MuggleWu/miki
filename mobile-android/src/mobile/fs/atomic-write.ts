// 原子写与"半写恢复"：先写 <path>.tmp，再改名覆盖 <path>。
//
// 为什么需要：decks.json / config.json 是整份重写的文件，裸 writeText 写到一半被杀进程
// 会留下半截 JSON —— 解析直接失败，牌组表/配置整套读不出来（卡片文件是追加写，不受影响）。
// 桌面端的对等实现是 src/main/atomic-write.ts（tmp + renameSync）。
//
// 手机端的 rename 语义是「目标存在时先删目标再改名」（Android 侧直接改名会报错），所以这中间
// 有一个目标短暂不存在的窗口。窗口里被杀：主文件没了，但 <path>.tmp 是完整的 —— 加载侧用
// readJsonDoc 兜底读它（并把主文件补回去），把"半写"变成可自愈。
import { type FileStore } from './types'

export const ATOMIC_TMP_SUFFIX = '.tmp'

/** 取某个路径对应的临时文件名（加载侧的兜底读取、测试断言都用它，避免各处拼字符串） */
export function tmpPathOf(path: string): string {
  return `${path}${ATOMIC_TMP_SUFFIX}`
}

/** 原子写：tmp 写全 → 改名覆盖。tmp 写失败时主文件一个字节都没动。 */
export async function atomicWriteText(store: FileStore, path: string, data: string): Promise<void> {
  const tmp = tmpPathOf(path)
  await store.writeText(tmp, data)
  await store.rename(tmp, path)
}

export interface JsonDocRead<T> {
  /** 解析出的文档；主文件与 tmp 都不可用时为 null */
  value: T | null
  /** 主文件存在但解析失败（文档损坏）——与"文件不存在"是两回事，健康报告要分开说 */
  mainCorrupt: boolean
  /** 内容取自 <path>.tmp 兜底（说明上一次原子写被打断） */
  fromTmp: boolean
}

/** 读一份 JSON 文档：主文件坏掉/缺失时退回同目录的 <path>.tmp。
 *  返回 null 值 + mainCorrupt 的组合让调用方自己决定"报损坏"还是"当空处理"。 */
export async function readJsonDoc<T>(store: FileStore, path: string): Promise<JsonDocRead<T>> {
  const main = await store.readText(path)
  if (main !== null) {
    try {
      return { value: JSON.parse(main) as T, mainCorrupt: false, fromTmp: false }
    } catch {
      // 落到 tmp 兜底
    }
  }
  const tmp = await store.readText(tmpPathOf(path))
  if (tmp !== null) {
    try {
      return { value: JSON.parse(tmp) as T, mainCorrupt: main !== null, fromTmp: true }
    } catch {
      // tmp 也不可用
    }
  }
  return { value: null, mainCorrupt: main !== null, fromTmp: false }
}
