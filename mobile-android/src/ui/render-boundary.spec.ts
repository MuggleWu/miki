// 移动端「页面崩了不能白屏」的不变量（源码级断言）。
//
// 为什么是源码级：手机端 vitest 跑在 node 环境（没有 jsdom / testing-library），挂载渲染
// 写不出来。而这条不变量一旦回归，后果不是显示错一点，而是**整棵树被卸载**：用户看到的
// 是一片白屏，连「设备自检」这个专门用来排查问题的页面都进不去，只能杀进程。
//
// 断言前先剥注释：解释性注释里会原样写出这些模式，不剥就会「注释满足断言」——
// 那条教训在 styles.spec.ts 里踩过（见那里的注释）。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 读源码并剥掉注释（块注释 + 行注释，含行尾注释），再去掉换行/缩进差异 */
function readSource(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/gm, '$1')
    .replace(/\s+/g, ' ')
}

const boundary = readSource('./components/ErrorBoundary.tsx')
const app = readSource('./App.tsx')
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** 路由上的每一页：label（用户看到的标题）→ 页面根组件的开标签 */
const PAGES: [label: string, tag: string][] = [
  ['牌组页出错了', '<DecksPage'],
  ['学习页出错了', '<StudyPage'],
  ['卡片库出错了', '<LibraryPage'],
  ['统计页出错了', '<StatsPage'],
  ['设置页出错了', '<SettingsPage'],
  ['设备自检出错了', '<SelfCheckPage']
]

/** 取选择器精确匹配的规则块内容（`styles.spec.ts` 里同一套取法） */
function blockOf(selector: string): string {
  const re = new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`)
  const m = re.exec(css)
  if (!m) return ''
  const start = m.index + m[0].length
  return css.slice(start, css.indexOf('}', start))
}

/** 断言「这一页被「这一条」边界包住」：边界开、页面、边界闭三者必须有序 */
function assertWrapped(label: string, tag: string): void {
  const open = app.indexOf(`<ErrorBoundary label="${label}">`)
  expect(open, `App.tsx 里没有 label="${label}" 的边界`).toBeGreaterThanOrEqual(0)
  const close = app.indexOf('</ErrorBoundary>', open)
  expect(close, `「${label}」的边界没有闭合`).toBeGreaterThan(open)
  const child = app.indexOf(tag, open)
  expect(child, `${tag} 不在「${label}」边界内——它抛错时整棵树会被卸载`).toBeGreaterThan(open)
  expect(child, `${tag} 跑到边界外面去了`).toBeLessThan(close)
}

describe('渲染错误边界：页面崩了要有可读兜底', () => {
  it('是 class 组件，且用 React 要求的两个静态/生命周期钩子接住错误', () => {
    // 函数组件接不住渲染期抛错（没有等价的钩子），只能是 class
    expect(boundary).toMatch(/class ErrorBoundary extends Component<Props, State>/)
    expect(boundary).toMatch(/static getDerivedStateFromError\(error: Error\)/)
    // componentDidCatch 负责把完整现场留给 logcat（手机上唯一的现场）
    expect(boundary).toMatch(/componentDidCatch\(error: Error, info: ErrorInfo\)/)
    expect(boundary).toContain('[miki] 渲染错误:')
  })

  it('给出可读提示、「重试」按钮，并把栈截断后再展示', () => {
    expect(boundary).toMatch(/label \?\? '这个页面出错了'/)
    expect(boundary).toMatch(/onClick=\{this\.retry\}/)
    expect(boundary).toContain('重试')
    // 栈要截断：完整栈在手机上贴不出去（上限 1200 字与桌面端一致）
    expect(boundary).toMatch(/\.slice\(0, 1200\)/)
  })

  it('「重试」会换 attempt 作 key 重挂载子树（而不是只清错误状态）', () => {
    // 只清 error 的话，导致崩溃的那份坏状态还在，重试会立刻再崩一次
    expect(boundary).toMatch(/Fragment key=\{this\.state\.attempt\}/)
    expect(boundary).toMatch(/attempt: s\.attempt \+ 1/)
  })

  it('App.tsx 里每一页都被自己的边界包住，且 label 按页面区分', () => {
    for (const [label, tag] of PAGES) assertWrapped(label, tag)
    // 页数对得上：将来新加页面忘了包边界（或只包一半）会在这里失败
    expect(app.match(/<ErrorBoundary /g)?.length).toBe(PAGES.length)
  })

  it('toggle 到别的页仍能自救：边界在 .app 内、抽屉与提示条在边界外', () => {
    // 抽屉（切页的唯一入口）不能被任何页面的错误带下去，否则用户没法换页
    const drawer = app.indexOf('<Drawer ')
    expect(drawer).toBeGreaterThan(app.lastIndexOf('</ErrorBoundary>'))
    expect(app.indexOf('<div className="toast"')).toBeGreaterThan(drawer)
  })

  it('styles.css 有错误边界的样式，且配色只走主题变量', () => {
    const blocks = [
      '.error-boundary',
      '.error-boundary-title',
      '.error-boundary-msg',
      '.error-boundary-hint',
      '.error-boundary-stack',
      '.error-boundary .btn'
    ].map(blockOf)
    for (const b of blocks) expect(b, '错误边界的样式块不能是空的（否则出错时是一屏裸文本）').not.toBe('')
    const all = blocks.join(' ')
    // 硬编码颜色在深色主题下必然错色：这里的每一处颜色都要来自 :root / [data-theme='dark'] 的主题变量
    expect(all).toMatch(/var\(--/)
    expect(all).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(all).not.toMatch(/\b(?:rgba?|hsla?)\(/)
  })
})
