// boldSelection 纯函数单测：⌘B 加粗开关键的各种选区形态
import { describe, expect, it } from 'vitest'
import { boldSelection } from '../components/AddEditDialog'

describe('boldSelection', () => {
  it('无选区：光标处插入 ****，光标落在中间', () => {
    expect(boldSelection('abc', 1, 1)).toEqual({
      text: 'a****bc',
      replaceStart: 1,
      replaceEnd: 1,
      replacement: '****',
      selStart: 3,
      selEnd: 3
    })
  })

  it('普通选区：两侧包 **，新选区保持内层内容', () => {
    expect(boldSelection('ab_cd_ef', 2, 6)).toEqual({
      text: 'ab**_cd_**ef',
      replaceStart: 2,
      replaceEnd: 6,
      replacement: '**_cd_**',
      selStart: 4,
      selEnd: 8
    })
  })

  it('选中内容自带 ** 对：去掉，选区落到内层', () => {
    expect(boldSelection('ab**cd**ef', 2, 8)).toEqual({
      text: 'abcdef',
      replaceStart: 2,
      replaceEnd: 8,
      replacement: 'cd',
      selStart: 2,
      selEnd: 4
    })
  })

  it('选区紧贴外侧 ** 对（选的是纯内容）：去掉外侧星号', () => {
    expect(boldSelection('ab**cd**ef', 4, 6)).toEqual({
      text: 'abcdef',
      replaceStart: 2,
      replaceEnd: 8,
      replacement: 'cd',
      selStart: 2,
      selEnd: 4
    })
  })

  it('恰选中一个 **：直接删除', () => {
    expect(boldSelection('ab**cd', 2, 4)).toEqual({
      text: 'abcd',
      replaceStart: 2,
      replaceEnd: 4,
      replacement: '',
      selStart: 2,
      selEnd: 2
    })
  })

  it('再来一次同一位置：去粗后再包回来（开关键幂等往返）', () => {
    const wrap = boldSelection('ab cd ef', 3, 5)
    expect(wrap.text).toBe('ab **cd** ef')
    const strip = boldSelection(wrap.text, wrap.selStart, wrap.selEnd)
    expect(strip.text).toBe('ab cd ef')
    expect([strip.selStart, strip.selEnd]).toEqual([3, 5])
  })
})
