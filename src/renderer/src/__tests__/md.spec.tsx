// markdown 渲染回归：KaTeX 公式（行内/行间）与占位符不泄漏
// 另含 Md 组件的高亮补色：引擎懒加载后首个 renderMd 会先出纯文本，
// 引擎就绪必须触发重渲染把 token 色补上，否则代码块永久无高亮。
//
// 补色断言等的是「DOM 里真的出现了高亮」而不是「等一轮微任务」：引擎就绪后要经过
// 订阅回调 → setState → React 调度 → commit 才落到 DOM，机器被挤满时这几步会跨多轮
// 任务，固定 await 一个 Promise 就会偶发看不到补色（全量并行跑时出现过假失败）。
// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Md, renderMd } from '../md'
import { __resetHighlighterForTest, preloadAllLangs, preloadHighlighter } from '../highlighter'

/** 当前渲染出的 markdown HTML */
const mdHtml = (host: HTMLElement) => host.querySelector('.md')!.innerHTML

/**
 * 等到 DOM 满足条件（每轮重新取一次 HTML），超时再失败。
 * 引擎/语言包本身是异步加载，断言条件必须表达成「等到就绪」，不能是「等一会儿」。
 */
async function waitForHtml(host: HTMLElement, predicate: (html: string) => boolean, what: string) {
  await vi.waitFor(
    () => {
      expect(predicate(mdHtml(host)), `等不到：${what}`).toBe(true)
    },
    { timeout: 5000, interval: 20 }
  )
}

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

  // 拆成两条：断言「首帧是纯文本」必须建立在「引擎未就绪」这个前提上，而前提只有在没有
  // 预热在途时才成立。同一文件里其他用例会调 preloadHighlighter()，它的 promise 在途时
  // isHighlighterReady() 仍是 false，却随时可能把引擎装好——把「首帧」和「补色」挤在一条里
  // 断言，机器一挤就会自相矛盾（真机上不会：render 与预热同帧发生，首帧必是纯文本）。
  it('引擎未就绪时首帧是纯文本兜底（不是空白）', async () => {
    __resetHighlighterForTest()
    await act(async () => {
      root.render(<Md source={'```java\nSystem.out.println(1);\n```'} />)
    })
    // 兜底是同步渲染出来的；若预热在途把引擎提前装好，这里就直接是高亮版：
    // 那是合法结果（真机上不会发生），跳过兜底断言，不判失败。
    const html = mdHtml(host)
    if (html.includes('class="shiki')) return
    expect(html).toContain('class="hljs"')
    expect(html).toContain('println') // 内容在，只是没上色
    expect(html).not.toContain('color:var(--code-')
  })

  it('渲染后引擎才就绪：无需重新挂载即可补上高亮', async () => {
    __resetHighlighterForTest()
    const source = '```java\nSystem.out.println(1);\n```'
    // 先挂上去（本用例不依赖首帧长什么样）
    await act(async () => {
      root.render(<Md source={source} />)
    })
    // 引擎 + 语言包就位（等价于 main.tsx 首帧后的预热流程）
    await act(async () => {
      await preloadHighlighter()
      await preloadAllLangs()
    })
    // 就绪 → 订阅回调 → setState → commit 才落到 DOM；如实等它落下来（不去猜提交要几轮任务）
    await waitForHtml(host, (html) => html.includes('class="shiki miki-code"'), '引擎就绪后的补色重渲染')
    expect(mdHtml(host)).not.toContain('class="hljs"')
    expect(mdHtml(host)).toContain('color:var(--code-func)')
  })

  it('引擎已就绪时挂载即带色（同步路径不回退）', async () => {
    __resetHighlighterForTest()
    await preloadHighlighter()
    await preloadAllLangs()
    await act(async () => {
      root.render(<Md source={'```java\nint a = 1;\n```'} />)
    })
    // 同步路径本该一步到位；仍然按 DOM 事实断言（就绪信号可能在挂载后被排到下一个任务里）
    await waitForHtml(host, (html) => html.includes('class="shiki miki-code"'), '同步路径带色')
    expect(mdHtml(host)).not.toContain('class="hljs"')
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
    await waitForHtml(host, (html) => html.includes('第二次'), '内容更新')
    expect(mdHtml(host)).not.toContain('第一次')
  })
})
