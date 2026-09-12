// 学习页「⋮ → 新增卡片」这条入口（源码级断言）。
//
// 为什么值得钉住：刷卡被打断的典型场景是"这张卡让我想到另一张卡"——此时人正在牌组里，
// 最不想干的事是退回首页、在牌组下拉里重新找到同一个牌组。默认牌组传错（比如漏传、
// 或写成"上次用的"）不会报错、不会崩，只会把卡静悄悄写进别的牌组——手机端**没有**
// 「移动牌组」功能，落错只能删了重建（同 add-form-deck-default.spec.ts 的教训）。
//
// 这里只断言源码结构：没有 jsdom / testing-library，渲染级用例写不出来
// （原因见 edit-form-mount.spec.ts）。断言前先剥注释——解释性注释里会原样写出这些模式。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 读源码并剥掉注释（块注释 + 整行行注释） */
function readSource(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const study = readSource('./pages/StudyPage.tsx')

describe('学习页「这张卡」菜单：就地新增卡片', () => {
  it('菜单里有「新增卡片」这一项', () => {
    expect(study).toMatch(/>\s*新增卡片\s*</)
  })

  it('点它开的是新增表单，且默认牌组是**当前刷的这个牌组**', () => {
    // 漏掉 defaultDeckId 就会退回「上次用的牌组」——在别的牌组加过卡就落错
    expect(study).toMatch(/<AddCardForm[^>]*defaultDeckId=\{deckId\}/)
  })

  it('表单是打开时才挂载的（初始牌组/上次用的牌组在挂载那一刻算）', () => {
    // 常驻挂载会让它一直停在"第一次打开时"的那份数据上，和首页抽屉同一条规矩
    expect(study).toMatch(/\{adding \? <AddCardForm/)
  })

  it('新增与编辑是两套弹层状态，互不复用', () => {
    // 复用同一个开关的话，编辑弹层会带着改过的内容变成新增弹层（或反过来）
    expect(study).toMatch(/const \[adding, setAdding\] = useState\(false\)/)
    expect(study).toMatch(/const \[editing, setEditing\] = useState\(false\)/)
  })
})
