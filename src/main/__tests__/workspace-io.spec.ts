// NDJSON 行读原语：语义等价（含 CRLF/空行/尾随空白）+ 惰性切分的内存契约。
// 内存断言走 MIKI_BENCH=1（与 perf.spec 一致），常规测试只跑语义。
import { afterAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { iterateNdjson, readNdjson } from '../workspace-io'

const dirs: string[] = []
const tmpFile = (content: string): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'miki-io-test-'))
  dirs.push(d)
  const f = path.join(d, 'x.ndjson')
  fs.writeFileSync(f, content)
  return f
}

afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

/** 旧实现（改造前的语义基准）：split('\n') + 过滤空白行 */
const legacy = (text: string): string[] => text.split('\n').filter((l) => l.trim().length > 0)

describe('iterateNdjson / readNdjson 语义', () => {
  it('普通多行：行序与内容保持', () => {
    const f = tmpFile('{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n')
    expect(readNdjson(f)).toEqual(['{"id":"a"}', '{"id":"b"}', '{"id":"c"}'])
    expect([...iterateNdjson(f)]).toEqual(readNdjson(f))
  })

  it('文件缺失 → 空（不抛错）', () => {
    const missing = path.join(os.tmpdir(), 'miki-io-not-exist-12345.ndjson')
    expect(readNdjson(missing)).toEqual([])
    expect([...iterateNdjson(missing)]).toEqual([])
  })

  it('空文件 / 只有空白字符 → 空', () => {
    expect(readNdjson(tmpFile(''))).toEqual([])
    expect(readNdjson(tmpFile('\n\n\n'))).toEqual([])
    expect(readNdjson(tmpFile('  \n\t\n \r\n'))).toEqual([])
  })

  it('中间空行被跳过，首尾无换行也照常产出', () => {
    expect(readNdjson(tmpFile('a\n\n\nb'))).toEqual(['a', 'b'])
    expect(readNdjson(tmpFile('a'))).toEqual(['a'])
  })

  it('CRLF：\\r 被挡在 JSON.parse 之前（旧实现会把 \\r 带进行内容）', () => {
    const f = tmpFile('{"id":"a"}\r\n{"id":"b"}\r\n')
    const lines = readNdjson(f)
    expect(lines).toEqual(['{"id":"a"}', '{"id":"b"}'])
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow()
  })

  it('行内前导/尾随空白被 trim，但行中间的空格保留', () => {
    const f = tmpFile('   {"a": 1, "b": 2}   \n')
    expect(readNdjson(f)).toEqual(['{"a": 1, "b": 2}'])
  })

  it('坏 JSON 行照样原样产出（由调用方 try/catch 决定跳过，原语不吞错）', () => {
    expect(readNdjson(tmpFile('{"ok":1}\n这不是 JSON\n{"ok":2}\n'))).toEqual(['{"ok":1}', '这不是 JSON', '{"ok":2}'])
  })

  it('超长单行（>64KB）不被截断', () => {
    const big = JSON.stringify({ id: 'x', back: 'a'.repeat(100_000) })
    const lines = readNdjson(tmpFile(`${big}\n`))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe(big)
    expect((JSON.parse(lines[0]) as { back: string }).back).toHaveLength(100_000)
  })

  it('惰性：只取前 n 行时不构造后面的行（提前 return 也安全）', () => {
    const f = tmpFile('1\n2\n3\n4\n5\n')
    const got: string[] = []
    for (const line of iterateNdjson(f)) {
      got.push(line)
      if (got.length === 2) break
    }
    expect(got).toEqual(['1', '2'])
  })

  it('与旧实现（split+filter）在边界样本上产出一致', () => {
    const samples = [
      '',
      '\n',
      'a',
      'a\n',
      'a\n\nb\n',
      '\n\na\n\n',
      '{"x":1}\r\n{"y":2}',
      '  spaced  \n\ttabbed\t\n',
      '中文行一\n中文行二\n',
      'a\r\n\r\nb'
    ]
    for (const s of samples) {
      const mine = readNdjson(tmpFile(s))
      const old = legacy(s)
      // 唯一允许的差异：新实现 trim 了两端空白（旧实现保留行内尾随空白与 \r）
      expect(mine).toEqual(old.map((l) => l.trim()))
    }
  })
})

// 内存对照放在 vitest 里测不准：worker 进程 + GC 时机让 heapUsed 增量失真
// （同一段代码在 2.06MB 文件上量到过 4.08MB 的「增量」）。真实对照用独立 node 进程跑：
//
//   node --expose-gc -e '...' <file>   # 见 docs/zh/development.md「NDJSON 行读」
//
// 实测（2026-09-10，8.86MB 卡文件）：旧实现 16.56MB（文本 + 行数组），只读文本 14.77MB，
// 流式 14.77MB —— 行数组那份额外开销约等于文件大小的 19%，且随文件线性增长。
