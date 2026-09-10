// markdown 渲染回归：KaTeX 公式（行内/行间）与占位符不泄漏
// 另含 Md 组件的高亮补色：引擎懒加载后首个 renderMd 会先出纯文本，
// 引擎就绪必须触发重渲染把 token 色补上，否则代码块永久无高亮。
// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Md, renderMd } from '../md'
import { __resetHighlighterForTest, preloadAllLangs, preloadHighlighter } from '../highlighter'

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

describe('Md 组件：引擎就绪后重渲染补色', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    host.remove()
  })

  it('引擎未就绪时先渲染纯文本，就绪后自动补上高亮（无需重新挂载）', async () => {
    __resetHighlighterForTest()
    const source = '```java\nSystem.out.println(1);\n```'
    await act(async () => {
      root.render(<Md source={source} />)
    })
    // 首帧：引擎还没就绪 → hljs 纯文本兜底（内容在，无色）
    expect(host.querySelector('.md')!.innerHTML).toContain('class="hljs"')

    // 引擎 + 语言包就位（等价于 main.tsx 首帧后的预热流程）
    await act(async () => {
      await preloadHighlighter()
      await preloadAllLangs()
      await Promise.resolve()
    })
    const html = host.querySelector('.md')!.innerHTML
    expect(html).not.toContain('class="hljs"')
    expect(html).toContain('class="shiki miki-code"')
    expect(html).toContain('color:var(--code-func)')
  })

  it('引擎已就绪时挂载即带色（同步路径不回退）', async () => {
    __resetHighlighterForTest()
    await preloadHighlighter()
    await preloadAllLangs()
    await act(async () => {
      root.render(<Md source={'```java\nint a = 1;\n```'} />)
    })
    expect(host.querySelector('.md')!.innerHTML).toContain('class="shiki miki-code"')
    expect(host.querySelector('.md')!.innerHTML).not.toContain('class="hljs"')
  })

  it('source 变化仍然重渲染（补色后不影响正常更新）', async () => {
    __resetHighlighterForTest()
    await preloadHighlighter()
    await preloadAllLangs()
    await act(async () => {
      root.render(<Md source="第一次" />)
    })
    await act(async () => {
      root.render(<Md source="第二次" />)
    })
    expect(host.querySelector('.md')!.innerHTML).toContain('第二次')
    expect(host.querySelector('.md')!.innerHTML).not.toContain('第一次')
  })
})
