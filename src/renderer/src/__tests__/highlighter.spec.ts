// Shiki 细粒度高亮回归：token 粒度（方法调用/类型独立着色）、CSS 变量引用、未知语言降级
import { beforeAll, describe, expect, it } from 'vitest'
import { highlightSync, preloadHighlighter } from '../highlighter'
import { renderMd } from '../md'

beforeAll(async () => {
  await preloadHighlighter()
})

describe('highlightSync', () => {
  it('java 方法调用获得独立 func token（hljs 时代无此粒度）', () => {
    const html = highlightSync('System.out.println("x");', 'java')
    expect(html).toContain('<pre class="shiki')
    expect(html).toContain('color:var(--code-func)">.println(')
    expect(html).toContain('color:var(--code-string)')
  })

  it('注释 italic 与关键字着色', () => {
    const html = highlightSync('// 注释\npublic final int n = 1;', 'java')
    expect(html).toContain('font-style:italic')
    expect(html).toContain('color:var(--code-comment)')
    expect(html).toContain('color:var(--code-keyword)')
    expect(html).toContain('color:var(--code-number)')
  })

  it('语言别名与大小写归一（sh → bash，JAVA → java）', () => {
    expect(highlightSync('echo hi', 'sh')).toContain('<pre class="shiki')
    expect(highlightSync('public class A {}', 'JAVA')).toContain('<pre class="shiki')
  })

  it('未预载语言降级纯文本，不抛错', () => {
    const html = highlightSync('MOVE A TO B.', 'cobol')
    expect(html).toContain('<pre class="shiki')
    expect(html).not.toContain('color:var(--code-')
  })

  it('空串与空语言安全', () => {
    expect(highlightSync('', 'java')).toContain('<pre class="shiki')
    expect(highlightSync('x', '')).toContain('<pre class="shiki')
  })
})

describe('renderMd 代码块集成', () => {
  it('围栏块走 Shiki，输出结构与 .md 样式契约一致', () => {
    const html = renderMd('```java\nSystem.out.println(1);\n```')
    expect(html).toContain('<pre class="shiki miki-code"')
    expect(html).toContain('<span class="line">')
    expect(html).not.toContain('class="hljs"')
  })

  it('无语言标注围栏块仍走 Shiki 纯文本（text 内置）', () => {
    const html = renderMd('```\nplain text\n```')
    expect(html).toContain('<pre class="shiki miki-code"')
  })

  it('转义正确：原始 < 不出现（数字实体转义），不产生真实标签', () => {
    const html = renderMd('```java\nString s = "<b>&amp;</b>";\n```')
    expect(html).toContain('&#x3C;b>')
    expect(html).not.toContain('<b>')
  })
})
