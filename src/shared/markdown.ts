// markdown 渲染管线：markdown-it + KaTeX（数学公式）。
//
// 为什么放在 shared 而不是各自一份：里面有一段"先把公式抽成占位符、渲染完再回填 KaTeX"
// 的逻辑，它是为了绕开 markdown 规则破坏公式里的 `_` `*` `<`。这段逻辑两端各写一遍
// 必然漂移——一旦漂移，同一张卡在桌面端和手机上的显示就不一样，而用户没有理由去分辨
// 哪个是对的。
//
// 代码高亮（Shiki）不进 shared：它体积大、且只有桌面端需要。这里留一个可注入的
// highlight 钩子，桌面端把自己的引擎接进来，移动端不接（代码块退化成转义纯文本）。
import MarkdownIt from 'markdown-it'
import katex from 'katex'

export interface MarkdownOptions {
  /**
   * 代码块高亮。返回 null 表示"这次拿不到高亮"（例如引擎尚未加载完），
   * 此时回退成转义纯文本；调用方可以顺手预热该语言的引擎。
   */
  highlight?: (code: string, lang: string) => string | null
}

export interface MarkdownRenderer {
  render(src: string): string
}

const BLOCK_MATH = /\$\$([\s\S]+?)\$\$/g
const INLINE_MATH = /\$([^$\n]+?)\$/g

export function createMarkdownRenderer(opts: MarkdownOptions = {}): MarkdownRenderer {
  const md: MarkdownIt = MarkdownIt({
    html: false,
    linkify: true,
    breaks: true,
    highlight(code, lang) {
      const html = opts.highlight?.(code, lang) ?? null
      if (html) return html
      return `<pre class="hljs"><code>${md.utils.escapeHtml(code)}</code></pre>`
    }
  })

  // 链接一律新开并断开 opener（桌面端由主进程转交系统浏览器；移动端由 WebView 打开）
  const defaultLinkOpen =
    md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    tokens[idx].attrSet('target', '_blank')
    tokens[idx].attrSet('rel', 'noopener noreferrer')
    return defaultLinkOpen(tokens, idx, options, env, self)
  }

  return {
    render(src: string): string {
      const math: { expr: string; display: boolean }[] = []
      const stash = (expr: string, display: boolean): string => {
        math.push({ expr, display })
        return `@@MIKIMATH${math.length - 1}@@`
      }
      const staged = (src ?? '')
        .replace(BLOCK_MATH, (_m, expr: string) => stash(expr, true))
        .replace(INLINE_MATH, (_m, expr: string) => stash(expr, false))

      let html = md.render(staged)

      html = html.replace(/@@MIKIMATH(\d+)@@/g, (_m, idx: string) => {
        const item = math[Number(idx)]
        if (!item) return ''
        try {
          return katex.renderToString(item.expr.trim(), { displayMode: item.display, throwOnError: false })
        } catch {
          return `<code>${md.utils.escapeHtml(item.expr)}</code>`
        }
      })
      return html
    }
  }
}
