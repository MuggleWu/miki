// M0 探针：设计文档里「验证不过就不往下写」的四条自检。
//
// 探针 1、2 只依赖本机文件系统（不需要任何凭据），装在手机上点一下就能出结论；
// 探针 3、4 要 PAT，放在 sync 模块的连通性自检里（见 src/mobile/sync/github.ts）。
//
// 探针用到的数据一律是**当场合成的假数据**——miki 仓库是公开仓库，真实学习数据
// 绝不能出现在源码或日志里。
//
// 落盘位置也一律在 `<工作区名>__selfcheck/` 这个旁路目录里（与探针 5 同一处，见 selfcheck.ts）：
// 探针一旦写进真实工作区，那台手机上就会多出一堆假卡和假事件，还要靠人手动去删。
import type { FileStore } from './fs'
import { SELFCHECK_DIR_SUFFIX } from './selfcheck'

export type ProbeStatus = 'pass' | 'fail' | 'skip'

export interface ProbeResult {
  id: string
  title: string
  status: ProbeStatus
  /** 逐条证据（原样展示给人看，也方便贴进实现日志） */
  detail: string[]
  /** 失败原因或待办 */
  note?: string
}

/** 探针 1：官方 Filesystem 插件在应用私有目录（Directory.Data）下的读写/追加/列举是否可用，以及真实路径 */
export async function probePrivateStorage(store: FileStore, root: string): Promise<ProbeResult> {
  const detail: string[] = []
  // 旁路目录（与探针 5 同款）：root 是**真实工作区**目录名，探针不能往它里面写
  const dir = `${root}${SELFCHECK_DIR_SUFFIX}`
  const file = `${dir}/probe/hello.ndjson`
  try {
    const absolute = await store.uri('')
    detail.push(`Directory.Data 实际路径：${absolute}`)

    await store.writeText(file, '{"n":1}\n')
    const after1 = await store.readText(file)
    detail.push(`write→read：${JSON.stringify(after1)}`)

    await store.appendText(file, '{"n":2}\n')
    const after2 = await store.readText(file)
    detail.push(`append→read：${JSON.stringify(after2)}`)

    const st = await store.stat(file)
    detail.push(`stat：size=${st?.size ?? 'null'} mtime=${st ? new Date(st.mtimeMs).toISOString() : 'null'}`)

    await store.mkdir(`${dir}/probe/sub`)
    const entries = await store.list(`${dir}/probe`)
    detail.push(`readdir：${entries.map((e) => `${e.name}(${e.type})`).join(', ')}`)

    await store.rename(file, `${dir}/probe/renamed.ndjson`)
    detail.push(
      `rename 后源文件：${JSON.stringify(await store.readText(file))}，目标文件：${JSON.stringify(await store.readText(`${dir}/probe/renamed.ndjson`))}`
    )

    await store.remove(`${dir}/probe`)
    const gone = await store.stat(`${dir}/probe/renamed.ndjson`)
    detail.push(`recursive remove 后 stat：${gone === null ? 'null（已删干净）' : JSON.stringify(gone)}`)

    const ok = after1 === '{"n":1}\n' && after2 === '{"n":1}\n{"n":2}\n' && st?.size === 16 && gone === null
    return {
      id: 'storage',
      title: '探针 1：应用私有目录读写（零权限）',
      status: ok ? 'pass' : 'fail',
      detail,
      note: ok ? undefined : '有断言不成立，逐条对照上面的证据'
    }
  } catch (e) {
    return {
      id: 'storage',
      title: '探针 1：应用私有目录读写（零权限）',
      status: 'fail',
      detail,
      note: `抛异常：${e instanceof Error ? e.message : String(e)}`
    }
  } finally {
    // 失败路径也要清：中途抛错留下的半截文件同样落在这台设备上（跑完即删对两条路径都成立）
    try {
      await store.remove(dir)
    } catch {
      // 清理失败不掩盖原始异常（与探针 5 同一口径）
    }
  }
}

/** 探针 2：2MB 级 NDJSON 的追加写与全量读实际耗时（桌面端目标量级 <50ms） */
export async function probeNdjsonPerf(
  store: FileStore,
  root: string,
  opts?: { mb?: number; rounds?: number }
): Promise<ProbeResult> {
  const mb = opts?.mb ?? 2
  const rounds = opts?.rounds ?? 20
  const detail: string[] = []
  // 同上：~2MB 的假 NDJSON 绝不能落在真实工作区里
  const dir = `${root}${SELFCHECK_DIR_SUFFIX}`
  const file = `${dir}/perf.ndjson`
  try {
    // 合成 ~2MB NDJSON（每行 ~200 字节的假卡）
    const line = JSON.stringify({
      id: 'probe-card-0000',
      front: '探针合成卡面：这段文字只是为了把行撑到两百字节左右，不包含任何真实学习内容。'.repeat(2),
      back: '探针合成卡背',
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
      suspended: false
    })
    const perLine = new TextEncoder().encode(line).length + 1
    const lines = Math.ceil((mb * 1024 * 1024) / perLine)
    const payload = Array.from(
      { length: lines },
      (_, i) => line.replace('0000', String(i).padStart(4, '0')) + '\n'
    ).join('')

    const t0 = performance.now()
    await store.writeText(file, payload)
    const writeMs = performance.now() - t0

    const t1 = performance.now()
    const readBack = await store.readText(file)
    const readMs = performance.now() - t1
    const bytes = new TextEncoder().encode(readBack ?? '').length
    detail.push(`合成文件：${lines} 行 / ${(bytes / 1048576).toFixed(2)} MB（首次整写 ${writeMs.toFixed(0)}ms）`)
    detail.push(`全量读回：${readMs.toFixed(0)}ms`)

    const appends: number[] = []
    for (let i = 0; i < rounds; i++) {
      const t = performance.now()
      await store.appendText(file, line.replace('0000', `a${String(i).padStart(3, '0')}`) + '\n')
      appends.push(performance.now() - t)
    }
    const sorted = [...appends].sort((a, b) => a - b)
    const avg = appends.reduce((a, b) => a + b, 0) / appends.length
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
    detail.push(
      `追加 ${rounds} 次：平均 ${avg.toFixed(1)}ms / 中位 ${sorted[Math.floor(sorted.length / 2)].toFixed(1)}ms / p95 ${p95.toFixed(1)}ms / 最慢 ${sorted[sorted.length - 1].toFixed(1)}ms`
    )

    await store.remove(dir)

    // 判定：追加耗时只做记录，不设硬门槛（桌面端「<50ms」已被裁决为不必达标）；
    // 这里只把「超过 300ms」标成 fail，那意味着每次答题都会卡手
    const ok = p95 < 300
    return {
      id: 'perf',
      title: '探针 2：2MB NDJSON 追加/读耗时',
      status: ok ? 'pass' : 'fail',
      detail,
      note: ok ? undefined : `p95 追加耗时 ${p95.toFixed(1)}ms 已超过 300ms，答题会明显卡顿`
    }
  } catch (e) {
    return {
      id: 'perf',
      title: '探针 2：2MB NDJSON 追加/读耗时',
      status: 'fail',
      detail,
      note: `抛异常：${e instanceof Error ? e.message : String(e)}`
    }
  } finally {
    // 抛异常时那份 ~2MB 合成文件还躺在设备上，不清理就是"自检跑一次、设备白占 2MB"
    try {
      await store.remove(dir)
    } catch {
      // 清理失败不掩盖原始异常（与探针 5 同一口径）
    }
  }
}
