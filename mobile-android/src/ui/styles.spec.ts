// 卡面样式的不变量：**给容器加的 white-space 会穿透到已经渲染好的 markdown 上**。
//
// 为什么值得单独钉住：卡面原来带 `white-space: pre-wrap`，本意是给"渲染管线还没就绪时的
// 纯文本回退"保住换行，但它作用在整张卡面上——而 markdown-it 生成的 HTML 每个块之间都
// 有换行，于是 `<p>a</p>\n<p>b</p>` 之间多出一整个行高、松列表的每个 `<li>` 里多出两行。
// 真机上量到：单行 `<li>` 高 85.6px（正文一行 26.4px），相邻列表项间隔 30px，整段列表
// 比正常高 3 倍多。用户报的"列表和空行分段间距特别大"就是这个。
//
// 这类"样式穿透 / 权重相同后写者赢"的坑在本项目已经出现三次（另有 .sheet-body、.legend
// 与 .muted）。CSS 没法用行为断言，所以这里直接对样式源文件断言不变量——比再犯一次便宜。
//
// 注意：断言前先去掉注释。第一版没去，结果 `.card-face` 规则块里那条解释性的注释
// （里面写着 "white-space: pre-wrap"）把断言直接顶翻了。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** 取选择器**精确匹配**的规则块内容（`.md` 不能命中 `.md.md-plain`）；同名规则取**最后**一条
 * （CSS 允许同一选择器写多条，后面的生效——本项目就踩过"后写者赢"的坑，所以这里要跟浏览器同口径） */
function blockOf(selector: string): string {
  const re = new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'g')
  let m: RegExpExecArray | null
  let last: string | null = null
  while ((m = re.exec(css)) !== null) {
    const start = m.index + m[0].length
    last = css.slice(start, css.indexOf('}', start))
  }
  return last ?? ''
}

describe('卡面 markdown 样式不变量', () => {
  it('已渲染的 .md 按正常空白处理', () => {
    expect(blockOf('.md')).toContain('white-space: normal')
  })

  it('pre-wrap 只留给纯文本回退，且权重压过 .md', () => {
    // 只写 .md-plain 与 .md 权重相同、靠"后写者赢"太脆，所以是两层选择器
    expect(blockOf('.md.md-plain')).toContain('white-space: pre-wrap')
    expect(blockOf('.md-plain')).toBe('')
  })

  it('卡面与预览容器自己不带 white-space（否则会穿透到渲染结果）', () => {
    expect(blockOf('.card-face')).not.toContain('white-space')
    expect(blockOf('.preview')).not.toContain('white-space')
  })
})

// 键盘遮挡这条不变量：光留 padding 不够，滚动容器还要有 scroll-padding——
// 浏览器把聚焦的输入框滚进可见区时只看这个，否则输入框会停在键盘上沿以下（看不见正在打的字）。
// 这类"CSS 语义只有在真机上才暴露"的东西没法用行为断言，只能对样式源文件钉不变量。
describe('键盘让位的不变量', () => {
  it('两个弹层滚动容器都有 scroll-padding-bottom，且与各自的留白同源', () => {
    expect(blockOf('.sheet-body')).toContain('scroll-padding-bottom: calc(16px + var(--bottom-blocked))')
    expect(blockOf('.sheet-full .sheet-body')).toContain('scroll-padding-bottom: calc(24px + var(--bottom-blocked))')
  })

  it('普通页体也能滚到键盘上面（卡片库搜索框就在页面里）', () => {
    expect(blockOf('.page-body')).toContain('scroll-padding-bottom')
  })

  it('底部让位统一走 --bottom-blocked（键盘与安全区取大者），不各自写 --kb', () => {
    // 弹层与提示条都贴屏幕底：只写 var(--kb) 会在没有键盘时压住导航栏，
    // 只写 var(--inset-bottom) 又会被键盘盖住
    expect(blockOf('.sheet')).toContain('--bottom-blocked')
    expect(blockOf('.toast')).toContain('--bottom-blocked')
  })
})
