// Shiki 细粒度高亮回归：token 粒度（方法调用/类型独立着色）、CSS 变量引用、未知语言降级。
// 懒加载改造后这里还多盯三件事：就绪前 highlightSync 必须返回 null（渲染层据此走纯文本）、
// 按需 ensureLang 后同一语言立即可同步高亮、引擎就绪信号只通知一次。
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetHighlighterForTest,
  ensureLang,
  highlightSync,
  isHighlighterReady,
  isSupportedLang,
  preloadAllLangs,
  preloadHighlighter,
  subscribeHighlighter,
  supportedLangs
} from '../highlighter'
import { renderMd } from '../md'

beforeAll(async () => {
  await preloadHighlighter()
  await preloadAllLangs()
})

/**
 * 把全局引擎恢复成「就绪 + 全部语言可用」。
 *
 * 高亮引擎是**模块级单例**：本文件里多条用例会 __resetHighlighterForTest() 来验证
 * 「未就绪」路径，而其余用例（含 renderMd 集成那组）依赖「就绪且语言已加载」。
 * 早先靠每条重置用例末尾自己 await preloadAllLangs() 把状态还回去——那是口头约定：
 * 机器被挤满时若某条用例中途失败/超时，后面的用例就带着被重置的单例跑，
 * 于是出现「同步高亮断言偶发看到纯文本」这种与被测代码无关的假失败。
 * 改成每条用例开始前统一兜底（已就绪时零成本）。
 */
async function ensureReadyState(): Promise<void> {
  if (!isHighlighterReady()) await preloadHighlighter()
  await preloadAllLangs()
}

beforeEach(async () => {
  await ensureReadyState()
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

  it('未知语言在引擎就绪后仍返回 null（与「受支持但未加载」表现一致）', () => {
    expect(isHighlighterReady()).toBe(true)
    // 懒加载表外的语言一律 null：调用方渲染成 <pre class="hljs">，不尝试未注册语法
    expect(highlightSync('MOVE A TO B.', 'cobol')).toBeNull()
    expect(renderMd('```cobol\nMOVE A TO B.\n```')).toContain('class="hljs"')
  })

  it('空串与空语言走内建 text 语法，不返回 null（围栏块渲染契约不变）', () => {
    expect(highlightSync('', 'java')).toContain('<pre class="shiki')
    expect(highlightSync('x', '')).toContain('<pre class="shiki')
    expect(highlightSync('x', 'text')).toContain('<pre class="shiki')
  })
})

describe('懒加载（首帧不阻塞）', () => {
  it('受支持语言清单与 18 个语言包一致（懒加载表不许漏项）', () => {
    expect(supportedLangs().sort()).toEqual(
      [
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
      ].sort()
    )
  })

  it('isSupportedLang：受支持语言为真，纯文本/未知语言为假', () => {
    expect(isSupportedLang('java')).toBe(true)
    expect(isSupportedLang('  Python ')).toBe(true)
    expect(isSupportedLang('text')).toBe(false)
    expect(isSupportedLang('')).toBe(false)
    expect(isSupportedLang('cobol')).toBe(false)
  })

  it('引擎就绪前 highlightSync 返回 null（渲染层据此走转义纯文本，不是空白）', async () => {
    __resetHighlighterForTest()
    expect(isHighlighterReady()).toBe(false)
    expect(highlightSync('System.out.println(1);', 'java')).toBeNull()
  })

  it('引擎就绪、语言未加载时仍返回 null，而不是错误地按纯文本着色', async () => {
    __resetHighlighterForTest()
    await preloadHighlighter()
    expect(isHighlighterReady()).toBe(true)
    expect(highlightSync('System.out.println(1);', 'java')).toBeNull() // java 包还没到

    await ensureLang('java')
    expect(highlightSync('System.out.println(1);', 'java')).not.toBeNull() // 一到就能同步高亮
    await ensureReadyState() // 恢复全局状态（契约见 ensureReadyState 注释）
  })

  it('ensureLang 同一语言并发调用合并为一次加载（不重复 import）', async () => {
    __resetHighlighterForTest()
    await preloadHighlighter()
    const [a, b] = await Promise.all([ensureLang('python'), ensureLang('python')])
    expect(a).toBeUndefined()
    expect(b).toBeUndefined()
    expect(highlightSync('def f(): pass', 'python')).toContain('color:var(--code-keyword)')
    await ensureReadyState()
  })

  it('不受支持的语言 ensureLang 立即 resolve，不产生加载', async () => {
    __resetHighlighterForTest()
    await preloadHighlighter()
    await expect(ensureLang('cobol')).resolves.toBeUndefined()
    await expect(ensureLang('')).resolves.toBeUndefined()
    await ensureReadyState()
  })

  it('subscribeHighlighter：就绪后订阅立即回调，退订后不再回调', async () => {
    __resetHighlighterForTest()
    const before = vi.fn()
    const off = subscribeHighlighter(before)
    expect(before).not.toHaveBeenCalled() // 尚未就绪
    await preloadHighlighter()
    await Promise.resolve() // 让 .then 回调跑完
    expect(before).toHaveBeenCalledTimes(1)

    off()
    const late = vi.fn()
    subscribeHighlighter(late)
    expect(late).toHaveBeenCalledTimes(1) // 已就绪：同步补发一次
    await ensureReadyState()
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

  it('引擎未就绪时围栏块退化为 hljs 纯文本（不空白、不抛错），渲染层随后重渲染补色', async () => {
    __resetHighlighterForTest()
    const plain = renderMd('```java\nSystem.out.println(1);\n```')
    expect(plain).toContain('class="hljs"')
    expect(plain).toContain('println') // 内容在，只是没上色
    expect(plain).not.toContain('color:var(--code-')

    await preloadHighlighter()
    await preloadAllLangs()
    const colored = renderMd('```java\nSystem.out.println(1);\n```')
    expect(colored).not.toContain('class="hljs"')
    expect(colored).toContain('color:var(--code-func)')
  })
})
