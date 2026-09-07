// tickSelection 单测：反引号单按包裹 + 三连按出围栏代码块（文本形态检测，不限按键间隔）
import { describe, expect, it } from 'vitest'
import { backtickSelection, tickSelection, tripleBacktick } from '../components/AddEditDialog'

describe('backtickSelection（单按）', () => {
  it('无选区：光标处插一对 ``，光标落中间', () => {
    expect(backtickSelection('abc', 1, 1)).toEqual({
      text: 'a``bc',
      replaceStart: 1,
      replaceEnd: 1,
      replacement: '``',
      selStart: 2,
      selEnd: 2
    })
  })

  it('有选区：两侧包 `，选区保持内层', () => {
    expect(backtickSelection('ab cd ef', 3, 5)).toEqual({
      text: 'ab `cd` ef',
      replaceStart: 3,
      replaceEnd: 5,
      replacement: '`cd`',
      selStart: 4,
      selEnd: 6
    })
  })
})

describe('tripleBacktick（第三下转换）', () => {
  it('无选区三连按：1 对 → 2 对 → 光标紧贴 ``|`` 时替换为空围栏块，光标落内容行', () => {
    // 第 1 下
    const r1 = tickSelection('ab', 2, 2)
    expect(r1.text).toBe('ab``')
    // 第 2 下：在两个 ` 中间
    const r2 = tickSelection(r1.text, r1.selStart, r1.selEnd)
    expect(r2.text).toBe('ab````')
    // 第 3 下：``|`` 形态触发代码块
    const r3 = tickSelection(r2.text, r2.selStart, r2.selEnd)
    expect(r3.text).toBe('ab```\n\n```')
    expect([r3.selStart, r3.selEnd]).toEqual([6, 6])
    // 纯函数直查与链路一致
    expect(tripleBacktick('ab````', 4, 4)).toEqual(r3)
  })

  it('选区三连按：已包一对 ` 的选区再按 2 下 → 双层形态替换为围栏块', () => {
    // 第 1 下：包裹 cd
    const r1 = tickSelection('ab cd ef', 3, 5)
    expect(r1.text).toBe('ab `cd` ef')
    // 第 2 下：选中 `cd`（外层）再包一层 → ``cd``
    const r2 = tickSelection(r1.text, r1.selStart, r1.selEnd)
    expect(r2.text).toBe('ab ``cd`` ef')
    // 第 3 下：选中外层 `` 对 → 转围栏块
    const r3 = tickSelection(r2.text, r2.selStart, r2.selEnd)
    expect(r3.text).toBe('ab ```\ncd\n``` ef')
    expect([r3.selStart, r3.selEnd]).toEqual([7, 9])
  })

  it('手选整段含包裹符再按三下：等价围栏块（不要求形态精确）', () => {
    // 用户手选 `cd`（含反引号）按下 `：先包成 `` `cd` ``？不——有选区直接包：
    // 实际链路：选 cd 按 1 下 → `cd`；选 `cd` 整段按 1 下 → `` `cd` ``（双层+内层）。
    // 三连按检测只认外侧紧贴 `` 的形态，此处验证非匹配形态不做转换
    expect(tripleBacktick('ab``cd``ef', 4, 4)).toBeNull()
    expect(tripleBacktick('ab`cd`ef', 3, 5)).toBeNull() // 外侧只有 1 个 `
  })

  it('围栏块内的空行光标位置：无选区转换后正好在两行 ``` 之间', () => {
    const r = tripleBacktick('x````', 3, 3)
    expect(r).not.toBeNull()
    expect(r!.text).toBe('x```\n\n```')
    expect(r!.text.slice(r!.selStart, r!.selEnd)).toBe('')
  })

  it('多行选区：围栏块包裹保持原换行', () => {
    const r = tripleBacktick('ab ``a\nb`` ef', 5, 8)
    expect(r).toEqual({
      text: 'ab ```\na\nb\n``` ef',
      replaceStart: 3,
      replaceEnd: 10,
      replacement: '```\na\nb\n```',
      selStart: 7,
      selEnd: 10
    })
  })
})
