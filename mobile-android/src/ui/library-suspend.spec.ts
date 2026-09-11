// 卡片库：暂停卡必须「看得出来、解得开」（源码级断言）。
//
// 为什么是源码级：手机端 vitest 跑在 node 环境（没装 jsdom / testing-library），组件挂不起来，
// 而这里要钉的是真机上才看得出来的两条行为。修复前整个 ui 目录只有学习页菜单调过
// setCardSuspended(id, false)，而暂停卡永远不会成为当前学习卡（调度器按 card.suspended 过滤），
// 那条「恢复学习」分支根本不可达——结果是「在手机上暂停一张卡就再也恢复不了，必须回桌面端」；
// 列表行又只显示调度状态与到期天数，暂停卡会一直写着「待复习 + 到期 +N 天」这种错信息。
//
// 断言前先剥注释，再把换行压成单空格：解释性注释里会原样写出这些模式（这条教训来自
// styles.spec.ts），而压平后断言就不受 prettier 折行影响。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 读源码、剥掉注释（块注释 + 整行行注释）、把连续空白压成单空格 */
function readSource(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
}

const page = readSource('./pages/LibraryPage.tsx')

describe('卡片库：暂停卡的显示', () => {
  it('列表行在 suspended 时显示「⏸ 已暂停」，而不是调度状态', () => {
    // 暂停卡仍带着 fsrs 快照与到期时间，照原样渲染会让人以为它还在排队等复习
    expect(page).toMatch(/r\.suspended \? '⏸ 已暂停' : STATE_LABEL\[r\.state\]/)
  })

  it('列表行对暂停卡不显示到期天数', () => {
    expect(page).toMatch(/!r\.suspended && r\.state !== 'new'/)
  })

  it('详情里的状态也标成暂停并说明不计入调度', () => {
    expect(page).toMatch(/row\.suspended \? '⏸ 已暂停（不计入调度）' : STATE_LABEL\[row\.state\]/)
  })
})

describe('卡片库：暂停 / 解除暂停', () => {
  it('详情里的两个分支各自调对参数、各自弹对提示', () => {
    expect(page).toMatch(/setCardSuspended\(row\.id, false\)[\s\S]{0,60}'已解除暂停'/)
    expect(page).toMatch(/setCardSuspended\(row\.id, true\)[\s\S]{0,60}'已暂停'/)
  })

  it('暂停态下走的是「解除暂停」（false），不是反过来的', () => {
    // 两个分支调的是同一个 API，只有布尔值不同：写反了两边都不报错，
    // 表现就是「按钮点了没反应」——卡永远解不开，或点了暂停反而恢复
    const branchAt = page.indexOf('{row.suspended ? (')
    expect(branchAt).toBeGreaterThan(-1)
    const elseAt = page.indexOf(') : (', branchAt)
    expect(elseAt).toBeGreaterThan(branchAt)
    const whenSuspended = page.slice(branchAt, elseAt)
    expect(whenSuspended).toContain('setCardSuspended(row.id, false)')
    expect(whenSuspended).not.toContain('setCardSuspended(row.id, true)')
  })
})
