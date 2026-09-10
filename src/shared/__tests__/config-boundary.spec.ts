// 渲染层可写配置边界单测（IPC.saveConfig 白名单）。
// 为什么值得专门钉住：loadWorkspace 会把完整 config（含 api.token）交给渲染层，
// 而 saveConfig 是 Object.assign 合并落盘。没有白名单时，渲染层手里一份陈旧
// config 快照回写，就能整份覆盖 api.token、FSRS 参数等调度真理项；多机环境下
// 热加载（git pull）刚改的参数也会被本机旧快照悄悄改回去。
//
// 唯一与主进程一致的收口点 = shared/ipc 的 RENDERER_WRITABLE_CONFIG_KEYS /
// pickRendererWritableConfig（main/index.ts 的 IPC.saveConfig handler 调它）。
import { describe, expect, it } from 'vitest'
import { pickRendererWritableConfig, RENDERER_WRITABLE_CONFIG_KEYS } from '../../shared/ipc'
import { DEFAULT_CONFIG } from '../../shared/types'

describe('渲染层可写配置白名单', () => {
  it('只放行界面相关键', () => {
    expect([...RENDERER_WRITABLE_CONFIG_KEYS].sort()).toEqual(
      ['browser', 'cardDialogWindow', 'leechThreshold', 'study', 'theme', 'window'].sort()
    )
  })

  it('放行：theme / study / browser / window / cardDialogWindow / leechThreshold', () => {
    const patch = {
      theme: 'dark',
      study: { fontSize: 20 },
      browser: { columns: ['front'] },
      window: { x: 1, y: 2, width: 800, height: 600, maximized: false },
      cardDialogWindow: { x: null, y: null, width: 700, height: 500 },
      leechThreshold: 3
    }
    expect(pickRendererWritableConfig(patch)).toEqual(patch)
  })

  it('丢掉 api：token 既不能被旧值复活，也不能被抹掉', () => {
    const out = pickRendererWritableConfig({
      api: { enabled: false, port: 1, token: 'stale-token-from-old-snapshot' },
      theme: 'dark'
    })
    expect(out).not.toHaveProperty('api')
    expect(out).toEqual({ theme: 'dark' })
  })

  it('丢掉调度真理项：parameters / desiredRetention / 学习步长 / 上限 / fuzzing', () => {
    const out = pickRendererWritableConfig({
      parameters: [0.1, 0.2],
      desiredRetention: 0.5,
      learningStepsSec: [1],
      relearningStepsSec: [2],
      maximumInterval: 7,
      enableFuzzing: false
    })
    expect(out).toEqual({})
  })

  it('丢掉 workspacePath：工作区指向只由主进程决定', () => {
    expect(pickRendererWritableConfig({ workspacePath: '/tmp/evil' })).toEqual({})
  })

  it('陈旧整份 config 回写（含 api.token）不会带出任何真理项，只留下界面键', () => {
    const staleSnapshot = {
      ...DEFAULT_CONFIG,
      workspacePath: '/Users/example/Documents/miki-base',
      api: { enabled: true, port: 8727, token: 'token-from-before-git-pull' },
      parameters: [9, 9, 9],
      // 可选字段：真实 config 落盘后才有（DEFAULT_CONFIG 不带）
      cardDialogWindow: { x: null, y: null, width: 700, height: 500 }
    }
    const out = pickRendererWritableConfig(staleSnapshot as unknown as Record<string, unknown>)
    // 界面键全数保留，六个真理项一个都没带出来
    expect(Object.keys(out).sort()).toEqual([...RENDERER_WRITABLE_CONFIG_KEYS].sort())
    expect(out).not.toHaveProperty('api')
    expect(out).not.toHaveProperty('parameters')
    expect(out).not.toHaveProperty('workspacePath')
    expect(out).not.toHaveProperty('desiredRetention')
    expect(out).not.toHaveProperty('enableFuzzing')
  })

  it('空补丁 / 全非法补丁 → 空对象（服务层据此判定无变更，不翻动 config.json）', () => {
    expect(pickRendererWritableConfig({})).toEqual({})
    expect(pickRendererWritableConfig({ nope: 1, __proto__: { polluted: true } })).toEqual({})
  })
})
