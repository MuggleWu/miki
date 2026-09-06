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
})
