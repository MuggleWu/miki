// markdown 渲染：markdown-it + KaTeX + highlight.js（学习页卡面 / 预览共用，需求 §6）
import { useMemo } from 'react'
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'
import katex from 'katex'

const md: MarkdownIt = MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(code, { language: lang }).value}</code></pre>`
      } catch {
        // 降级为转义输出
      }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(code)}</code></pre>`
  }
})

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
