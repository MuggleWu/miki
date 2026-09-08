// enterContinueList 单测：Enter 列表续行（行末补同级标记 / 空项退出 / 其余不接管走默认换行）
import { describe, expect, it } from 'vitest'
import { enterContinueList } from '../components/AddEditDialog'

describe('enterContinueList', () => {
  it('无序表行末回车：下一行补 - ，光标落新标记后', () => {
    expect(enterContinueList('- 项目一', 5, 5)).toEqual({
      text: '- 项目一\n- ',
      replaceStart: 5,
      replaceEnd: 5,
      replacement: '\n- ',
      selStart: 8,
      selEnd: 8
    })
  })

  it('缩进沿用：  - 子项回车补   - ', () => {
    expect(enterContinueList('  - 子项', 6, 6)).toEqual({
      text: '  - 子项\n  - ',
      replaceStart: 6,
      replaceEnd: 6,
      replacement: '\n  - ',
      selStart: 11,
      selEnd: 11
    })
  })

  it('tab 缩进沿用', () => {
    expect(enterContinueList('\t- 内容', 5, 5)).toEqual({
      text: '\t- 内容\n\t- ',
      replaceStart: 5,
      replaceEnd: 5,
      replacement: '\n\t- ',
      selStart: 9,
      selEnd: 9
    })
  })

  it('有序列表数字 +1', () => {
    expect(enterContinueList('1. 第一项', 6, 6)?.text).toBe('1. 第一项\n2. ')
    expect(enterContinueList('1. 第一项', 6, 6)?.selStart).toBe(10)
  })

  it('有序 9. 进位到 10.，括号风格 1) 到 2)', () => {
    expect(enterContinueList('9. 九', 4, 4)?.text).toBe('9. 九\n10. ')
    expect(enterContinueList('1) 第一', 5, 5)?.text).toBe('1) 第一\n2) ')
  })

  it('* 和 + 标记原样沿用', () => {
    expect(enterContinueList('* 星号', 4, 4)?.text).toBe('* 星号\n* ')
    expect(enterContinueList('+ 加号', 4, 4)?.text).toBe('+ 加号\n+ ')
  })

  it('标记后多空格：续行沿用第一个空白字符（归一为单空格）', () => {
    expect(enterContinueList('-   缩进空格', 8, 8)?.text).toBe('-   缩进空格\n- ')
  })

  it('文档中间的列表行末回车：只在该行后插入，不动下一行', () => {
    expect(enterContinueList('前文\n3) 第三\n后文', 8, 8)).toEqual({
      text: '前文\n3) 第三\n4) \n后文',
      replaceStart: 8,
      replaceEnd: 8,
      replacement: '\n4) ',
      selStart: 12,
      selEnd: 12
    })
  })

  it('空列表项回车退出：删标记只留缩进，光标落行首缩进后', () => {
    expect(enterContinueList('- \n后续', 2, 2)).toEqual({
      text: '\n后续',
      replaceStart: 0,
      replaceEnd: 2,
      replacement: '',
      selStart: 0,
      selEnd: 0
    })
  })

  it('缩进的空项退出：保留缩进', () => {
    expect(enterContinueList('  - \n后续', 4, 4)).toEqual({
      text: '  \n后续',
      replaceStart: 0,
      replaceEnd: 4,
      replacement: '  ',
      selStart: 2,
      selEnd: 2
    })
  })

  it('有序空项同样退出', () => {
    expect(enterContinueList('1. \n后续', 3, 3)?.text).toBe('\n后续')
  })

  it('续行后立刻再回车：空项退出成普通空行，再回车不接管', () => {
    const r1 = enterContinueList('- a', 3, 3)
    expect(r1?.text).toBe('- a\n- ')
    // 第二下：光标在新 - 行末 → 退出列表
    const r2 = enterContinueList(r1!.text, r1!.selStart, r1!.selEnd)
    expect(r2).toEqual({
      text: '- a\n',
      replaceStart: 4,
      replaceEnd: 6,
      replacement: '',
      selStart: 4,
      selEnd: 4
    })
    // 第三下：普通空行不接管，走默认换行
    expect(enterContinueList(r2!.text, r2!.selStart, r2!.selEnd)).toBeNull()
  })

  it('不接管的情形返回 null：非列表 / 无空格 / 光标不在行末 / 有选区', () => {
    expect(enterContinueList('普通文字', 4, 4)).toBeNull()
    expect(enterContinueList('-abc', 4, 4)).toBeNull() // 标记后无空白不算列表
    expect(enterContinueList('1.abc', 5, 5)).toBeNull()
    expect(enterContinueList('- 项目', 2, 2)).toBeNull() // 光标在行中间
    expect(enterContinueList('- 项目', 0, 5)).toBeNull() // 有选区
    expect(enterContinueList('- a\n- b', 1, 1)).toBeNull() // 中间行中途换行
    expect(enterContinueList('', 0, 0)).toBeNull()
    expect(enterContinueList('- ', 0, 1)).toBeNull() // 选区非光标
  })
})
