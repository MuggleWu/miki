// markdown 渲染：markdown-it + KaTeX + Shiki TextMate 高亮（学习页卡面 / 预览共用，需求 §6）。
//
// 管线本身在 shared/markdown.ts：公式占位符回填那段逻辑两端共用，各写一份必然漂移。
// 这里只做两件渲染器外部的事：接上 Shiki 高亮引擎（懒加载，highlighter.ts），
// 以及 Md 组件订阅引擎就绪后重渲染一次补上 token 色。
import { useEffect, useMemo, useState } from 'react'
import { createMarkdownRenderer, type MarkdownRenderer } from '../../shared/markdown'
import { ensureLang, highlightSync, isSupportedLang, subscribeHighlighter } from './highlighter'

const renderer: MarkdownRenderer = createMarkdownRenderer({
  highlight(code, lang) {
    const html = highlightSync(code, lang)
    if (html) return html
    // 该语言受支持但尚未加载 → 触发加载，本次先走纯文本，就绪后由 Md 重渲染
    if (isSupportedLang(lang)) void ensureLang(lang)
    return null
  }
})

/** 渲染 markdown（公式先抽占位符、渲染后回填 KaTeX，实现见 shared/markdown.ts） */
export function renderMd(src: string): string {
  return renderer.render(src)
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
