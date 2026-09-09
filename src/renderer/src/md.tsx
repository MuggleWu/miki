// markdown 渲染：markdown-it + KaTeX + Shiki TextMate 高亮（学习页卡面 / 预览共用，需求 §6）。
// 高亮引擎在 main.tsx 预载（highlighter.ts），未就绪时代码块退化为转义纯文本，首帧不空白。
import { useMemo } from 'react'
import MarkdownIt from 'markdown-it'
import katex from 'katex'
import { highlightSync } from './highlighter'

const md: MarkdownIt = MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(code, lang) {
    const html = highlightSync(code, lang)
    if (html) return html
    return `<pre class="hljs"><code>${md.utils.escapeHtml(code)}</code></pre>`
  }
})

// 链接一律新开（主进程会把外链转交系统浏览器），并断开 opener
const defaultLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank')
  tokens[idx].attrSet('rel', 'noopener noreferrer')
  return defaultLinkOpen(tokens, idx, options, env, self)
}

const BLOCK_MATH = /\$\$([\s\S]+?)\$\$/g
const INLINE_MATH = /\$([^$\n]+?)\$/g

/** 公式先抽成占位符，markdown 渲染后回填 KaTeX，避免公式被 markdown 规则破坏 */
export function renderMd(src: string): string {
  const math: { expr: string; display: boolean }[] = []
  const stash = (expr: string, display: boolean): string => {
    math.push({ expr, display })
    return `@@MIKIMATH${math.length - 1}@@`
  }
  const staged = src
    .replace(BLOCK_MATH, (_m, expr: string) => stash(expr, true))
    .replace(INLINE_MATH, (_m, expr: string) => stash(expr, false))

  let html = md.render(staged)

  html = html.replace(/@@MIKIMATH(\d+)@@/g, (_m, idx: string) => {
    const item = math[Number(idx)]
    if (!item) return ''
    try {
      return katex.renderToString(item.expr.trim(), {
        displayMode: item.display,
        throwOnError: false
      })
    } catch {
      return `<code>${md.utils.escapeHtml(item.expr)}</code>`
    }
  })
  return html
}

export function Md({ source }: { source: string }) {
  const html = useMemo(() => renderMd(source ?? ''), [source])
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
}
