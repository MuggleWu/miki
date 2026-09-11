// 卡面 markdown 渲染（学习页 / 编辑预览 / 卡片详情共用）。
//
// 与桌面端同一份管线（shared/markdown.ts）——公式占位符回填那段逻辑只有一处实现。
// 差异只有一个：**不接代码高亮**。Shiki 的语法/主题数据是 MB 级，而这是以文字卡为主的应用，
// 卡面上的代码块几乎不会出现；真出现时代码块以转义纯文本呈现，不影响内容正确性。
// shared 里留了 highlight 钩子，将来要补不需要改结构。
//
// 管线本身懒加载：markdown-it + katex 加起来几百 KB，而首屏（牌组列表）根本用不到它。
// 未就绪时先按纯文本渲染（与桌面端"引擎就绪前先出纯文本"同一策略），
// 并且在 boot 完成后预取，等用户点进牌组时通常已经就位。
import { useEffect, useState, type ReactNode } from 'react'
import type { MarkdownRenderer } from '@shared/markdown'

let pending: Promise<MarkdownRenderer> | null = null

function loadRenderer(): Promise<MarkdownRenderer> {
  return (pending ??= Promise.all([
    import('@shared/markdown'),
    // KaTeX 的 CSS 跟着这个懒加载块一起进来：它有几 MB 字体资源，
    // 放进主包会让首屏白等，而牌组列表根本用不到公式。
    import('katex/dist/katex.min.css')
  ]).then(([m]) => m.createMarkdownRenderer()))
}

/** 预取渲染管线（boot 后调用）：用户点进牌组前把它们拉下来，避免第一张卡闪一下原文 */
export function prefetchMarkdown(): void {
  void loadRenderer()
}

/** 渲染器就绪前返回 null，调用方据此走纯文本回退 */
export function useMarkdownRenderer(): MarkdownRenderer | null {
  const [r, setR] = useState<MarkdownRenderer | null>(null)
  useEffect(() => {
    let alive = true
    void loadRenderer().then((m) => {
      if (alive) setR(m)
    })
    return () => {
      alive = false
    }
  }, [])
  return r
}

export function Md({ source, className }: { source: string; className?: string }): JSX.Element {
  const renderer = useMarkdownRenderer()
  if (!renderer) {
    // 回退保持换行语义（与 markdown 的 breaks: true 一致），否则会挤成一行
    return <div className={`md md-plain${className ? ` ${className}` : ''}`}>{source}</div>
  }
  return (
    <div
      className={`md${className ? ` ${className}` : ''}`}
      dangerouslySetInnerHTML={{ __html: renderer.render(source) }}
    />
  )
}

/** 预览切换用：把 Markdown 当纯文本看（用户能确认自己打的标记没写错） */
export function Plain({ source }: { source: string }): ReactNode {
  return <div className="md md-plain">{source}</div>
}
