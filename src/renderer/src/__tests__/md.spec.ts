// markdown 渲染回归：KaTeX 公式（行内/行间）与占位符不泄漏
import { describe, expect, it } from 'vitest'
import { renderMd } from '../md'

describe('renderMd', () => {
  it('行内公式 $a=1$ 渲染为 KaTeX，无占位符与原文泄漏', () => {
    const html = renderMd('$a=1$')
    expect(html.match(/class="katex"/g)).toHaveLength(1)
    expect(html).toContain('katex-mathml')
    expect(html).toContain('annotation encoding="application/x-tex">a=1<')
    expect(html).not.toContain('@@MIKIMATH')
    expect(html).not.toContain('$a=1$')
  })

  it('行间公式 $$a=1$$ 渲染为 display 模式', () => {
    const html = renderMd('$$a=1$$')
    expect(html).toContain('katex-display')
    expect(html).not.toContain('@@MIKIMATH')
    expect(html).not.toContain('$$')
  })

  it('公式内含 markdown 特殊字符不被 markdown 规则破坏', () => {
    const html = renderMd('$a_b * c$ 与 $x<y$')
    expect(html).toContain('annotation encoding="application/x-tex">a_b * c<')
    expect(html).toContain('annotation encoding="application/x-tex">x&lt;y<')
    expect(html).not.toContain('<em>') // * 不应被 markdown 当成强调
    expect(html).not.toContain('@@MIKIMATH')
  })

  it('普通 markdown 不受影响', () => {
    const html = renderMd('# 标题\n\n**bold** 与 `code`')
    expect(html).toContain('<h1>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>code</code>')
  })

  it('空串安全', () => {
    expect(renderMd('')).toBe('')
  })

  it('链接带 target=_blank 与 rel=noopener noreferrer', () => {
    const html = renderMd('[站点](https://example.com)')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('自动链接（linkify）同样带安全属性', () => {
    const html = renderMd('访问 https://example.com 看看')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('原始 HTML 不渲染（html:false），脚本被转义', () => {
    const html = renderMd('<script>alert(1)</script> 与 <img src=x onerror=alert(1)>')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;script&gt;')
  })

  it('javascript: 协议链接被 markdown-it 拒绝', () => {
    const html = renderMd('[点我](javascript:alert(1))')
    expect(html).not.toContain('href="javascript:')
  })
})
