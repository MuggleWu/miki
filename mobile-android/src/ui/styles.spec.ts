// 卡面样式的不变量：**给容器加的 white-space 会穿透到已经渲染好的 markdown 上**。
//
// 为什么值得单独钉住：卡面原来带 `white-space: pre-wrap`，本意是给"渲染管线还没就绪时的
// 纯文本回退"保住换行，但它作用在整张卡面上——而 markdown-it 生成的 HTML 每个块之间都
// 有换行，于是 `<p>a</p>\n<p>b</p>` 之间多出一整个行高、松列表的每个 `<li>` 里多出两行。
// 真机上量到：单行 `<li>` 高 85.6px（正文一行 26.4px），相邻列表项间隔 30px，整段列表
// 比正常高 3 倍多。用户 报的"列表和空行分段间距特别大"就是这个。
//
// 这类"样式穿透 / 权重相同后写者赢"的坑在本项目已经出现三次（另有 .sheet-body、.legend
// 与 .muted）。CSS 没法用行为断言，所以这里直接对样式源文件断言不变量——比再犯一次便宜。
//
// 注意：断言前先去掉注释。第一版没去，结果 `.card-face` 规则块里那条解释性的注释
// （里面写着 "white-space: pre-wrap"）把断言直接顶翻了。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** 取选择器**精确匹配**的规则块内容（`.md` 不能命中 `.md.md-plain`） */
function blockOf(selector: string): string {
  const re = new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`)
  const m = re.exec(css)
  if (!m) return ''
  const start = m.index + m[0].length
  return css.slice(start, css.indexOf('}', start))
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
