// 代码高亮：Shiki TextMate 引擎（VS Code 同源语法粒度，补 hljs 不标方法调用/类型的缺口）。
// 细粒度引入（shiki/core + 按需语言包）而非全量 bundle，控制包体；纯 JS 正则引擎免 wasm。
// 主题是自定义的「miki-code」：token 色不写死色值，直接引用 styles.css 的 --code-* 语义变量
// ——浅色/深色由 data-theme 重定义变量自动生效，无需双主题机制。
import type { HighlighterCore, ThemeRegistration } from 'shiki/core'
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

import langBash from '@shikijs/langs/bash'
import langC from '@shikijs/langs/c'
import langCpp from '@shikijs/langs/cpp'
import langCsharp from '@shikijs/langs/csharp'
import langCss from '@shikijs/langs/css'
import langGo from '@shikijs/langs/go'
import langHtml from '@shikijs/langs/html'
import langJava from '@shikijs/langs/java'
import langJavascript from '@shikijs/langs/javascript'
import langJson from '@shikijs/langs/json'
import langKotlin from '@shikijs/langs/kotlin'
import langMarkdown from '@shikijs/langs/markdown'
import langPython from '@shikijs/langs/python'
import langRust from '@shikijs/langs/rust'
import langSql from '@shikijs/langs/sql'
import langTypeScript from '@shikijs/langs/typescript'
import langXml from '@shikijs/langs/xml'
import langYaml from '@shikijs/langs/yaml'

export const HIGHLIGHT_LANGS = [
  'bash', 'c', 'cpp', 'csharp', 'css', 'go', 'html', 'java', 'javascript',
  'json', 'kotlin', 'markdown', 'python', 'rust', 'sql', 'typescript', 'xml', 'yaml'
] as const

const LANG_MODULES = {
  bash: langBash, c: langC, cpp: langCpp, csharp: langCsharp, css: langCss, go: langGo,
  html: langHtml, java: langJava, javascript: langJavascript, json: langJson, kotlin: langKotlin,
  markdown: langMarkdown, python: langPython, rust: langRust, sql: langSql, typeScript: langTypeScript,
  xml: langXml, yaml: langYaml
} as const

// scope 匹配走 TextMate 前缀规则：'keyword' 覆盖 keyword.*，与旧 --code-* 语义一一对应
const MIKI_THEME: ThemeRegistration = {
  name: 'miki-code',
  type: 'dark',
  colors: { 'editor.foreground': 'var(--text)', 'editor.background': 'var(--pre-bg)' },
  tokenColors: [
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: 'var(--code-comment)', fontStyle: 'italic' } },
    { scope: ['string', 'punctuation.definition.string'], settings: { foreground: 'var(--code-string)' } },
    { scope: ['constant.numeric', 'constant.language', 'constant.character.escape'], settings: { foreground: 'var(--code-number)' } },
    { scope: ['keyword', 'storage'], settings: { foreground: 'var(--code-keyword)' } },
    { scope: ['entity.name.function', 'support.function', 'meta.method-call', 'variable.function'], settings: { foreground: 'var(--code-func)' } },
    { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class', 'entity.name.tag', 'entity.name.namespace'], settings: { foreground: 'var(--code-type)' } }
  ]
}

const PLAIN_LANGS = new Set(['', 'text', 'txt', 'plain', 'plaintext'])

let highlighterPromise: Promise<HighlighterCore> | null = null
let highlighter: HighlighterCore | null = null

/** 预载高亮引擎与语言包（main.tsx 渲染 React 前调用；重入安全，约 100ms） */
export function preloadHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [MIKI_THEME],
    langs: Object.values(LANG_MODULES),
    engine: createJavaScriptRegexEngine()
  }).then((h) => {
    highlighter = h
    return h
  })
  return highlighterPromise
}

/** 预载完成后的同步高亮（md.tsx highlight 钩子用）；未就绪或失败返回 null，调用方走转义兜底 */
export function highlightSync(code: string, lang: string): string | null {
  const h = highlighter
  if (!h) return null
  const name = (lang ?? '').trim().toLowerCase()
  const resolved =
    name && !PLAIN_LANGS.has(name) && h.getLoadedLanguages().includes(name) ? name : 'text'
  try {
    return h.codeToHtml(code, { lang: resolved, theme: 'miki-code' })
  } catch {
    return null
  }
}
