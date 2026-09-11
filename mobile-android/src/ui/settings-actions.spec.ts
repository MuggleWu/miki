// 设置页两个「清空」动作的不变量（源码级断言）。
//
// 为什么是源码级：手机端 vitest 跑在 node 环境（没有 jsdom / testing-library），点按钮、
// 看弹层挂载不出来。而这两个按钮各自有一个"点错了没法挽回"的后果：
//   ① 清空凭据删的是 PAT（明文没别处留底），删了只能回 GitHub 重新生成——所以必须先确认；
//   ② 「清空本机偏好」名不符实过：只删了 lastDeckId 却提示"已清空本机偏好"，用户以为
//      主题/字号也回去了（其实没变）；反过来，顺手把同步配置一起删掉同样可怕——那是断同步。
//
// 断言前先剥注释：这两条修复的说明里原样写着这些模式，不剥就会「注释满足断言」。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 读源码并剥掉注释（块注释 + 行注释，含行尾注释），再去掉换行/缩进差异 */
function readSource(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/gm, '$1')
    .replace(/\s+/g, ' ')
}

const src = readSource('./pages/SettingsPage.tsx')

/** 「清空本机偏好」那一段（函数体）：断言钉在这段里，别的 prefRemove 蹭不到 */
const clearFn = ((): string => {
  const start = src.indexOf('async function clearLocalPrefs')
  const end = src.indexOf('const dmg = ws.damageReport()')
  return start >= 0 && end > start ? src.slice(start, end) : ''
})()

/** 「清空凭据」那个按钮与其确认弹层的源码片段 */
const dangerBtn = ((): string => {
  const at = src.indexOf('className="btn danger"')
  return at < 0 ? '' : src.slice(at, src.indexOf('</button>', at))
})()
const confirmBlock = ((): string => {
  const at = src.indexOf('<Confirm')
  return at < 0 ? '' : src.slice(at, src.indexOf('/>', at))
})()

describe('清空凭据：删 PAT 不可逆，必须先确认', () => {
  it('按钮只负责打开确认，不再单击即删', () => {
    expect(dangerBtn, '设置页里没找到「清空凭据」按钮').not.toBe('')
    expect(dangerBtn).toContain('setConfirmClear(true)')
    expect(dangerBtn, '按钮自己调了 clearSyncCreds——那就又变回单击即生效了').not.toContain('clearSyncCreds')
  })

  it('真正的删除只在确认弹层的 onConfirm 里，且全文件只有这一处调用', () => {
    expect(confirmBlock, '设置页里没有确认弹层').not.toBe('')
    expect(confirmBlock).toContain('open={confirmClear}')
    expect(confirmBlock).toContain('clearSyncCreds()')
    expect(src.match(/clearSyncCreds\(\)/g)?.length, '删除调用必须唯一，且在上面那个确认里').toBe(1)
  })

  it('确认文案说清后果：PAT 删了不可恢复、要去 GitHub 重生成、仓库名保留', () => {
    // 只说"确定吗"等于没问（Confirm 组件自己的注释里就是这条口径）
    expect(confirmBlock).toContain('PAT 会被删掉')
    expect(confirmBlock).toContain('重新去 GitHub 生成')
    expect(confirmBlock).toContain('仓库名与分支会保留')
  })
})

describe('清空本机偏好：删的确实是"偏好"，而且立刻生效', () => {
  it('显示偏好三项（主题/字号/常亮）+ 上次用的牌组都删掉', () => {
    expect(clearFn, '找不到清偏好那段代码').not.toBe('')
    expect(clearFn).toMatch(/prefRemove\(PREF_KEYS\.theme\)/)
    expect(clearFn).toMatch(/prefRemove\(PREF_KEYS\.fontScale\)/)
    expect(clearFn).toMatch(/prefRemove\(PREF_KEYS\.keepAwake\)/)
    expect(clearFn).toMatch(/prefRemove\(PREF_KEYS\.lastDeckId\)/)
    // 全文件只该有这 4 处删除：多删一项就是"清偏好"顺手删了别的东西
    expect(src.match(/prefRemove\(/g)?.length).toBe(4)
  })

  it('不碰同步配置与同步记账（它们不是偏好，删掉等于把同步断了）', () => {
    expect(src).not.toMatch(/prefRemove\(PREF_KEYS\.(?:github|syncBase|syncVerify|lastSyncAt)/)
  })

  it('删除后调 loadPrefs 刷新内存态（不然要重启才看得出清空了）', () => {
    expect(clearFn).toMatch(/await loadPrefs\(\)/)
  })

  it('提示语如实：不再宣称"已清空本机偏好"却只删了上次的牌组', () => {
    expect(src).not.toContain('已清空本机偏好（工作区数据不受影响）')
    expect(clearFn).toContain('主题跟随系统')
  })
})
