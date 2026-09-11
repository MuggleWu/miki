// 新增卡片表单「往哪个牌组加卡」的口径（纯函数单测 + 源码级断言）。
//
// 为什么值得单测：默认值原来是一个「依赖 decks 的 effect」——deckInfos() 每次渲染都返回新数组，
// 于是每次渲染都重放一遍，用户在下拉里选完牌组、接着打一个字就被弹回「上次用的牌组」，
// 保存后卡片落进错误的牌组。这类 bug 不报错、也不崩，只会静默把卡写进别的牌组，
// 而手机端**没有**「移动牌组」功能（桌面端有），落错只能删了重建。
// 所以这里钉两件事：判断口径本身（pickDeckId 可在 node 里穷举），以及「没有任何 effect
// 再把用户的已选值写回去」。
//
// import 组件模块是可行的：AddCardForm 的顶层只有 import 与函数声明，不碰 DOM；渲染级用例
// 依然写不出来（没有 jsdom / testing-library），原因见 edit-form-mount.spec.ts。
//
// 断言前先剥注释：解释性注释里会原样写出这些模式，不剥就会「注释满足断言」——这条教训在
// styles.spec.ts 里踩过。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { pickDeckId } from './forms/AddCardForm'

/** 读源码并剥掉注释（块注释 + 整行行注释） */
function readSource(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const src = readSource('./forms/AddCardForm.tsx')

describe('pickDeckId：该用哪个牌组', () => {
  const ids = ['d1', 'd2', 'd3']

  it('用户选过的牌组说了算，迟到的「上次用的牌组」覆盖不了它', () => {
    // 这就是那个 B 级错误本身：选完 d3 之后，任何一次渲染都不能把选择变回 d2
    expect(pickDeckId({ deckIds: ids, chosenId: 'd3', lastUsedId: 'd2' })).toBe('d3')
  })

  it('还没选过时用上次用过的牌组', () => {
    expect(pickDeckId({ deckIds: ids, chosenId: null, lastUsedId: 'd2' })).toBe('d2')
  })

  it('上次用过的牌组不存在（或从没存过）就退回第一个', () => {
    expect(pickDeckId({ deckIds: ids, chosenId: null, lastUsedId: 'gone' })).toBe('d1')
    expect(pickDeckId({ deckIds: ids, chosenId: null, lastUsedId: null })).toBe('d1')
  })

  it('已选的牌组被删掉时不把它当成有效选择（否则保存会写进一个不存在的牌组）', () => {
    expect(pickDeckId({ deckIds: ids, chosenId: 'gone', lastUsedId: 'd2' })).toBe('d2')
    expect(pickDeckId({ deckIds: ids, chosenId: 'gone', lastUsedId: 'also-gone' })).toBe('d1')
  })

  it('牌组还没到（列表为空）时给空串，canSave 据此保持禁用', () => {
    expect(pickDeckId({ deckIds: [], chosenId: null, lastUsedId: 'd2' })).toBe('')
  })
})

describe('AddCardForm：牌组选择只由用户改', () => {
  it('当前牌组由 pickDeckId 在渲染期派生', () => {
    expect(src).toMatch(/=\s*pickDeckId\(\{/)
  })

  it('调用点把这两个 state 原样交进去（对调或写死常量都等于让偏好盖掉用户的选择）', () => {
    // 位置参数时写反了编译器不报错、组件又挂不起来，所以要钉住「传的是 chosenId / lastUsedId
    // 本身」而不是别的表达式；这两个值同类型（string | null），任何值级对调都不会被类型挡住
    const call = /=\s*pickDeckId\(\{[^}]*\}\)/.exec(src)?.[0] ?? '(调用点没找到)'
    expect(call).toMatch(/chosenId\s*,/)
    expect(call).toMatch(/lastUsedId\s*[,}]/)
  })

  it('没有任何 setDeckId：牌组不再被 effect 写回', () => {
    // 只要有人把「用偏好覆盖 deckId」写回来（哪怕加了 ref 判重躲过第一次渲染），这条会红
    expect(src).not.toMatch(/setDeckId/)
  })

  it('读「上次用的牌组」的 effect 不依赖 decks（它每次渲染都是新数组引用）', () => {
    const deps = [...src.matchAll(/\}\s*,\s*\[([^\]]*)\]\s*\)/g)].map((m) => m[1])
    // 先确认认出了依赖数组（正则退化时下面那条会「通过」得毫无意义）
    expect(deps.length).toBeGreaterThan(0)
    expect(deps.filter((d) => /\bdecks\b/.test(d))).toEqual([])
  })
})
