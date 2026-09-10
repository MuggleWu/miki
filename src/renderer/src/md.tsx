// markdown 渲染：markdown-it + KaTeX + Shiki TextMate 高亮（学习页卡面 / 预览共用，需求 §6）。
// 高亮引擎懒加载（highlighter.ts）：首帧不等引擎，代码块先以转义纯文本渲染。
// md.render 是同步 API 没法 await，所以这里做两件事：hook 里顺手 ensureLang 预热该语言；
// Md 组件订阅引擎就绪，就绪后重渲染一次补上 token 色（此后每次渲染都是同步带色）。
import { useEffect, useMemo, useState } from 'react'
import MarkdownIt from 'markdown-it'
import katex from 'katex'
import { ensureLang, highlightSync, isSupportedLang, subscribeHighlighter } from './highlighter'

const md: MarkdownIt = MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(code, lang) {
    const html = highlightSync(code, lang)
    if (html) return html
    // 该语言受支持但尚未加载 → 触发加载，本次先走纯文本，就绪后由 Md 重渲染
    if (isSupportedLang(lang)) void ensureLang(lang)
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

/**
 * 高亮引擎版本号：就绪前恒为 0，就绪时自增一次（触发重渲染）。
 * 用版本号而不是布尔量，是为了让它成为 renderMd 的一个真实入参（见下），
 * 而不是靠 useMemo 依赖数组里塞一个「函数没用到的值」来强制失效。
 */
function useHighlighterVersion(): number {
  const [version, setVersion] = useState(0)
  useEffect(() => subscribeHighlighter(() => setVersion((v) => v + 1)), [])
  return version
}

/**
 * 渲染 markdown。engineVersion 只参与缓存键：引擎就绪那一刻版本变化，
 * 同一份 source 需要重新渲染一次才能补上代码块 token 色（首次渲染时引擎尚未就绪）。
 * 参数在函数体里未被读取是有意的——缓存键本身就是它的用途。
 */
export function renderCachedMd(source: string, engineVersion: number): string {
  void engineVersion
  return renderMd(source ?? '')
}

export function Md({ source }: { source: string }) {
  const engineVersion = useHighlighterVersion()
  const html = useMemo(() => renderCachedMd(source, engineVersion), [source, engineVersion])
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
}
