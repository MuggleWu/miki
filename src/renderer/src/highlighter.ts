// 代码高亮：Shiki TextMate 引擎（VS Code 同源语法粒度，补 hljs 不标方法调用/类型的缺口）。
// 细粒度引入（shiki/core + 按需语言包）而非全量 bundle，控制包体；纯 JS 正则引擎免 wasm。
// 主题是自定义的「miki-code」：token 色不写死色值，直接引用 styles.css 的 --code-* 语义变量
// ——浅色/深色由 data-theme 重定义变量自动生效，无需双主题机制。
//
// 懒加载（首帧不阻塞）：引擎与 18 个语言包原先都是静态 import，全部进主 chunk——首帧必须等
// 5.5MB 主包解析完、再等 shiki 把 18 个语法编译完（实测约 126ms）才能画第一个像素。现在
// shiki/core、正则引擎、每个语言包都走动态 import，各自独立 chunk：首帧只加载应用本身，
// 高亮引擎在首帧之后异步就位，代码块先以转义纯文本出现（highlightSync 返回 null 的既有语义），
// 就绪后由 subscribeHighlighter 通知 Md 重渲染补色。
import type { HighlighterCore, LanguageRegistration, ThemeRegistration } from 'shiki/core'

export const HIGHLIGHT_LANGS = [
  'bash',
  'c',
  'cpp',
  'csharp',
  'css',
  'go',
  'html',
  'java',
  'javascript',
  'json',
  'kotlin',
  'markdown',
  'python',
  'rust',
  'sql',
  'typescript',
  'xml',
  'yaml'
] as const

/**
 * 语言名 → 语言包路径键。刻意用「键→thunk」而不是「键→已 import 的模块对象」：
 * 后者即便写成函数也会在模块顶层完成静态 import，语言包照样进主 chunk，懒加载失效。
 * 语法名到包名的映射（ts→typescript、c#→csharp 等）由 shiki 的 langs 解析，无需重复维护。
 */
const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  bash: () => import('@shikijs/langs/bash'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  css: () => import('@shikijs/langs/css'),
  go: () => import('@shikijs/langs/go'),
  html: () => import('@shikijs/langs/html'),
  java: () => import('@shikijs/langs/java'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  markdown: () => import('@shikijs/langs/markdown'),
  python: () => import('@shikijs/langs/python'),
  rust: () => import('@shikijs/langs/rust'),
  sql: () => import('@shikijs/langs/sql'),
  typescript: () => import('@shikijs/langs/typescript'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml')
}

/** 语言包导出名与文件名不同（typescript.ts 导出 typescript；部分包导出 default） */
function pickLangModule(mod: unknown, key: string): LanguageRegistration | LanguageRegistration[] {
  const m = mod as Record<string, unknown>
  const v = m[key] ?? m.default ?? m
  return v as LanguageRegistration | LanguageRegistration[]
}

// scope 匹配走 TextMate 前缀规则：'keyword' 覆盖 keyword.*，与旧 --code-* 语义一一对应
const MIKI_THEME: ThemeRegistration = {
  name: 'miki-code',
  type: 'dark',
  colors: { 'editor.foreground': 'var(--text)', 'editor.background': 'var(--pre-bg)' },
  tokenColors: [
    {
      scope: ['comment', 'punctuation.definition.comment'],
      settings: { foreground: 'var(--code-comment)', fontStyle: 'italic' }
    },
    { scope: ['string', 'punctuation.definition.string'], settings: { foreground: 'var(--code-string)' } },
    {
      scope: ['constant.numeric', 'constant.language', 'constant.character.escape'],
      settings: { foreground: 'var(--code-number)' }
    },
    { scope: ['keyword', 'storage'], settings: { foreground: 'var(--code-keyword)' } },
    {
      scope: ['entity.name.function', 'support.function', 'meta.method-call', 'variable.function'],
      settings: { foreground: 'var(--code-func)' }
    },
    {
      scope: [
        'entity.name.type',
        'entity.name.class',
        'support.type',
        'support.class',
        'entity.name.tag',
        'entity.name.namespace'
      ],
      settings: { foreground: 'var(--code-type)' }
    }
  ]
}

const PLAIN_LANGS = new Set(['', 'text', 'txt', 'plain', 'plaintext'])

let highlighterPromise: Promise<HighlighterCore> | null = null
let highlighter: HighlighterCore | null = null
/** 已加载（或正在加载）的语言名；避免重复 import 与重复注册语法 */
const langPromises = new Map<string, Promise<void>>()

/**
 * 引擎启动（零语言包）：只加载 shiki/core 与正则引擎，两个小 chunk。
 * 语言包按需在 ensureLang 里补注册，故启动不再编译 18 个语法。
 */
export function preloadHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript')
    ])
    const h = await createHighlighterCore({
      themes: [MIKI_THEME],
      langs: [],
      engine: createJavaScriptRegexEngine()
    })
    highlighter = h
    return h
  })()
  return highlighterPromise
}

/**
 * 按需加载并注册一个语言包；同一语言的并发请求合并成一个 promise。
 * 返回的 promise 永不 reject：某个语言包加载失败只影响该语言的配色，
 * 不该把「高亮整体不可用」扩散给调用方（失败后该语言会一直走纯文本兜底）。
 */
export function ensureLang(rawName: string): Promise<void> {
  const name = (rawName ?? '').trim().toLowerCase()
  if (!name || PLAIN_LANGS.has(name) || !(name in LANG_LOADERS)) return Promise.resolve()
  const existing = langPromises.get(name)
  if (existing) return existing
  const p = (async () => {
    const [h, mod] = await Promise.all([preloadHighlighter(), loadLangModule(name)])
    await h.loadLanguage(mod)
  })().catch(() => {
    /* 单语言失败：保持未加载，highlightSync 会退回纯文本 */
  })
  langPromises.set(name, p)
  return p
}

async function loadLangModule(name: string): Promise<LanguageRegistration | LanguageRegistration[]> {
  const mod = await LANG_LOADERS[name]()
  return pickLangModule(mod, name)
}

type Listener = () => void
const listeners = new Set<Listener>()

/**
 * 订阅「引擎已就绪」。就绪后立刻回调一次（订阅者可能在就绪后才挂载）。
 * 用于 md.tsx：首个 renderMd 若早于引擎就绪会渲染成纯文本，就绪后需要重渲染补色。
 * 返回退订函数。
 */
export function subscribeHighlighter(fn: Listener): () => void {
  if (highlighter) {
    fn()
    return () => {}
  }
  listeners.add(fn)
  // 就绪时统一通知（只会触发一次；highlighterPromise 只会 resolve 一次）
  void preloadHighlighter().then(() => {
    for (const l of [...listeners]) l()
    listeners.clear()
  })
  return () => listeners.delete(fn)
}

/** 引擎是否已就绪（测试与判断用；就绪前 highlightSync 一律返回 null） */
export function isHighlighterReady(): boolean {
  return highlighter !== null
}

/**
 * 同步高亮（md.tsx highlight 钩子用，md.render 是同步 API 不能等）。
 * 未就绪 / 该语言不在懒加载表内 / 语言包尚未到位 → 返回 null，调用方走转义纯文本兜底；
 * 调用方同时应 ensureLang 预热，就绪后重渲染即带色。
 *
 * 这里刻意只认懒加载表里的语言：未知语言（cobol 之类）与「受支持但还没加载」
 * 必须给出同一个 null——否则前者按纯文本渲染、后者去尝试未注册语法，同一份 markdown
 * 在两次渲染之间会出现两种表现。
 *
 * 无语言标注（或标注 text/plain）的围栏块例外：它是 Shiki 内建 text 语法，不走懒加载表，
 * 引擎一就绪就能直接着色（保持改造前「围栏块一律出 shiki 结构」的渲染契约）。
 */
export function highlightSync(code: string, lang: string): string | null {
  const h = highlighter
  if (!h) return null
  const name = (lang ?? '').trim().toLowerCase()
  if (!name || PLAIN_LANGS.has(name)) {
    return safeCodeToHtml(h, code, 'text')
  }
  // getLoadedLanguages() 返回的是已注册语法名 + 其别名（bash 包注册后为
  // ['shellscript','bash','sh','shell','zsh']），所以 ```sh 这类别名能直接命中。
  return h.getLoadedLanguages().includes(name) ? safeCodeToHtml(h, code, name) : null
}

function safeCodeToHtml(h: HighlighterCore, code: string, lang: string): string | null {
  try {
    return h.codeToHtml(code, { lang, theme: 'miki-code' })
  } catch {
    return null
  }
}

/**
 * 语言名是否受支持：既是懒加载表里的键，也可以是已加载语法声明的别名（sh/c++/ts 等）。
 * 判断别名要靠 getLoadedLanguages()，故引擎未就绪时只知道表里的规范名。
 */
export function isSupportedLang(rawName: string): boolean {
  const name = (rawName ?? '').trim().toLowerCase()
  if (!name || PLAIN_LANGS.has(name)) return false
  if (name in LANG_LOADERS) return true
  return highlighter?.getLoadedLanguages().includes(name) ?? false
}

/**
 * 预热全部受支持语言：并行加载 18 个语言 chunk（各是独立小文件）。
 * 语义与原先「静态 import 全部语言包」一致（一次启动后全语言可用），区别是这批
 * 请求发生在首帧之后且不阻塞渲染。单个语言失败不影响其他语言（ensureLang 已吞异常）。
 */
export function preloadAllLangs(): Promise<void> {
  return Promise.all(Object.keys(LANG_LOADERS).map((name) => ensureLang(name))).then(() => undefined)
}

/** 受支持的语言名（用户显式指定方言时用；shiki 内部再做别名解析） */
export function supportedLangs(): string[] {
  return Object.keys(LANG_LOADERS)
}

/** 测试用：重置模块级状态（生产代码不要调用） */
export function __resetHighlighterForTest(): void {
  highlighter = null
  highlighterPromise = null
  langPromises.clear()
  listeners.clear()
}
