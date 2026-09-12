// 新增卡片「连续录入」这条不变量（纯函数口径 + 源码级断言）。
//
// 为什么值得钉住：保存后关不关抽屉，只有一个"手感"信号，代码上不报错也不崩——
// 改回去（保存即 onDone）在浏览器里点一次也"能存进去"，只是每录一张都要重开抽屉、
// 重选牌组；而牌组一旦被弹回「上次用的」，卡片还会静悄悄落进别的牌组（手机端没有
// 「移动牌组」功能，落错只能删了重建）。所以这条要用断言钉住：
//   1. 保存成功路径**不** onDone（抽屉不关）、且只清正反面；
//   2. onDone 只挂在「关闭」按钮上，是唯一的收工出口；
//   3. 清空后光标回到正面（键盘不主动收，接着打下一张）。
//
// 断言前先剥注释：解释性注释里会原样写出这些模式，不剥就会「注释满足断言」。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 读源码并剥掉注释（块注释 + 整行行注释） */
function readSource(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const src = readSource('./forms/AddCardForm.tsx')
/** 只取 save 函数体本身（到它的收尾大括号为止）——后面的 JSX 会把 setChosenId 这些带进来 */
function saveBody(source: string): string {
  const start = source.indexOf('async function save')
  const end = source.indexOf('\n  }\n', start) // 函数缩进两格的收尾
  return source.slice(start, end === -1 ? undefined : end)
}
const save = saveBody(src)

describe('AddCardForm：保存后连续录入', () => {
  it('截出的确实是 save 函数体（正则退化时下面几条会「通过」得毫无意义）', () => {
    expect(save).toMatch(/^async function save/)
    expect(save).toMatch(/await ws\.addCard\(/)
    expect(save).not.toMatch(/<form/) // 没把 JSX 一起带进来
  })

  it('保存成功路径不关抽屉', () => {
    expect(save).not.toMatch(/onDone/)
  })

  it('保存后清空正反面，但不动牌组', () => {
    expect(save).toMatch(/setFront\(''\)/)
    expect(save).toMatch(/setBack\(''\)/)
    expect(save).not.toMatch(/setChosenId/)
  })

  it('清空后光标回到正面（键盘不主动收）', () => {
    expect(save).toMatch(/frontRef\.current\?\.focus\(\)/)
    expect(src).toMatch(/ref=\{frontRef\}/)
  })

  it('「关闭」是唯一的收工出口，且不会顺带提交表单', () => {
    expect(src).toMatch(/<button className="btn" type="button" onClick=\{onDone\}>/)
  })
})
