// 学习页编辑表单的「换卡必须换内容」不变量（源码级断言）。
//
// 为什么是源码级：手机端 vitest 跑在 node 环境（没装 jsdom / testing-library），渲染级用例写不出来，
// 而这个 bug 是「弹层一直挂着 + 表单内容在挂载时冻住」的运行时行为。它一旦回归的后果不是显示错一点，
// 而是**静默写坏数据**：界面显示 A 的内容，保存时目标 id 却是 B，把 A 的正面写进 B。
// 而且库里 43% 的卡 updatedAt 相同，乐观锁（拿冻结的基准比对）拦不住。
//
// 断言前先剥注释：解释性注释里会原样写出这些模式，不剥就会「注释满足断言」——那条教训在 styles.spec.ts 里踩过。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 读源码并剥掉注释（块注释 + 整行行注释） */
function readSource(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const form = readSource('./forms/CardEditForm.tsx')
const page = readSource('./pages/StudyPage.tsx')

describe('学习页编辑表单：换卡必须换内容', () => {
  it('CardEditForm 内部按 cardId 换实例（冻结的快照 state 必须随卡换掉）', () => {
    // 内容 / 乐观锁基准都是惰性 useState，只在挂载时算一次；调用方可能一直挂着只换 prop。
    // 用 key 把这条不变量钉在组件内部，任何调用方写错都不会显示/写入别的卡。
    expect(form).toMatch(/<CardEditFormBody\s+key=\{props\.cardId\}/)
  })

  it('学习页只在编辑页打开时挂载它（快照 = 打开那一刻，而不是页面首帧那一刻）', () => {
    // Sheet 始终渲染 children：写成无条件挂载时，表单从学习页首帧起就冻住了，
    // 刷到下一张卡后打开编辑页看到的仍是首帧那张卡。
    expect(page).toMatch(/\{editing && card \? \(\s*<CardEditForm/)
  })
})
