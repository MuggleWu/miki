// 同步配置表单：「只有仓库改了、PAT 留空」必须能保存（渲染级 + 源码级双重断言）。
//
// 背景：PAT 留空的语义是「不改 token」——saveSyncConfig 收 null，creds.ts 只在非空时写，
// 输入框的 placeholder 也明写着"已存 …，留空则不改"。但原来的 canSave 要求 token 非空，
// 于是"只想换个仓库名"这条最常见的路径被按钮封死：提示语说留空就行，按钮却是灰的。
//
// 为什么能真的渲染：react-dom/server 不需要 DOM，node 环境里就能把组件渲染成 HTML，
// 于是「保存按钮到底 disabled 没有」可以直接断言，不只是对着源码正则。
//
// 为什么必须替掉 store：zustand 走 useSyncExternalStore，SSR 阶段取的是**初始** state
// （getServerState / getInitialState），setState 之后再渲染仍是老状态——只能换成桩注入。
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

interface StubStatus {
  repo: string
  branch: string
  tokenMask: string | null
  configured: boolean
}

const stub = vi.hoisted(() => ({ status: null as StubStatus | null }))

vi.mock('./store', () => ({
  useApp: (sel: (s: unknown) => unknown) =>
    sel({ sync: { status: stub.status }, saveSyncConfig: async () => undefined })
}))

const { SyncConfigForm } = await import('./forms/SyncConfigForm')

/** 渲染表单，取出「保存并验证」那个按钮的标记（disabled 与否就看它） */
function saveButton(status: StubStatus | null): string {
  stub.status = status
  const html = renderToStaticMarkup(createElement(SyncConfigForm, { onDone: () => undefined }))
  const at = html.indexOf('保存并验证')
  return html.slice(html.lastIndexOf('<button', at), html.indexOf('</button>', at))
}

const CONFIGURED: StubStatus = { repo: 'owner/repo', branch: 'main', tokenMask: 'gith****abcd', configured: true }

describe('同步配置表单：留空保存', () => {
  it('已经存过 PAT 时可留空保存（仓库预填、token 空 → 按钮可点）', () => {
    const btn = saveButton(CONFIGURED)
    expect(btn, '「已配置过凭据 + PAT 留空」被按钮封死了——这正是回退的地方').not.toContain('disabled')
  })

  it('首次配置仍必须填 PAT（没有已存凭据时按钮是灰的）', () => {
    expect(saveButton(null)).toContain('disabled=""')
  })

  it('仓库本身填不对时依旧不能保存（放宽 token 不等于放宽仓库）', () => {
    expect(saveButton({ ...CONFIGURED, repo: '这不是仓库' })).toContain('disabled=""')
  })

  it('提示语与行为一致：已存 PAT 时 placeholder 明说「留空则不改」', () => {
    stub.status = CONFIGURED
    const html = renderToStaticMarkup(createElement(SyncConfigForm, { onDone: () => undefined }))
    expect(html).toContain('留空则不改')
  })
})

describe('同步配置表单：canSave 的源码形状', () => {
  // 剥掉注释再去掉换行/缩进差异：断言不依赖格式，但解释性注释会原样写出这些模式
  const src = readFileSync(new URL('./forms/SyncConfigForm.tsx', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/gm, '$1')
    .replace(/\s+/g, ' ')

  it('canSave 里除了「填了 token」还有「已配置过」这一支', () => {
    const at = src.indexOf('const canSave =')
    expect(at, '找不到 canSave').toBeGreaterThanOrEqual(0)
    const expr = src.slice(at, at + 160)
    expect(expr).toMatch(/token\.trim\(\)\.length > 0/)
    expect(expr, '缺少「已存过凭据」这一支，就是上面那条渲染级断言的根因').toMatch(/\|\|\s*configured\b/)
  })

  it('「已配置过」的判据来自 store 里的真实配置状态（不是写死的常量）', () => {
    const at = src.indexOf('const configured =')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(src.slice(at, at + 80)).toContain('sync.status?.configured')
  })

  it('保存时留空仍走「不改 token」的语义', () => {
    expect(src).toMatch(/token\.trim\(\) === '' \? null : token\.trim\(\)/)
  })
})
