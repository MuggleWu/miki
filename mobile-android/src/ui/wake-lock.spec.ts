// 学习页「屏幕常亮」在切走再回来之后必须还生效（源码级断言）。
//
// 为什么是源码级：常亮是浏览器 API + 文档可见性事件驱动的运行时行为，node 环境（没 jsdom）
// 挂载不出来。而这条不变量悄悄回归的代价很具体：**切出去接个电话再回来，刷卡时屏幕照常
// 息屏**——用户以为常亮还开着（设置页那一栏也还勾着），只是刷卡时手一停屏幕就黑。
//
// 根因是规范行为：文档隐藏时浏览器自己释放 Screen Wake Lock，而原来的 effect 只依赖
// route.kind 与 prefs.keepAwake，回到前台这两个值都没变 → effect 不会重跑 → 永远不会重新申请。
//
// 断言前先剥注释：修复说明里原样写着 visibilitychange 这些词，不剥就会「注释满足断言」。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 读 App.tsx 并剥掉注释（块注释 + 行注释，含行尾注释），再去掉换行/缩进差异 */
const src = ((): string => {
  return (
    readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // 行尾注释也要剥：`release() // 旧句柄` 这种写成一行时，中间那句解释会把断言顶翻
      .replace(/(^|\s)\/\/[^\n]*/gm, '$1')
      .replace(/\s+/g, ' ')
  )
})()

describe('学习页常亮：回到前台要重新获取', () => {
  it('申请常亮的前置条件不变（只在学习页 + 用户开了常亮）', () => {
    expect(src).toMatch(/route\.kind !== 'study' \|\| !prefs\.keepAwake/)
  })

  it('订阅了 visibilitychange，且回到可见时重新申请、隐藏时释放', () => {
    expect(src).toMatch(/document\.addEventListener\('visibilitychange'/)
    // 监听器必须在 effect 清理里摘掉，否则换页/改偏好会累积监听器
    expect(src).toMatch(/document\.removeEventListener\('visibilitychange'/)

    const at = src.indexOf('const onVisibility')
    expect(at, '找不到 visibilitychange 的处理函数').toBeGreaterThanOrEqual(0)
    const handler = src.slice(at, at + 220)
    expect(handler, '回到可见时没有重新申请的路径（这正是「切走再回来失效」的根因）').toContain(
      "visibilityState === 'visible'"
    )
    expect(handler).toMatch(/visible'\)\s*acquire\(\)/)
    expect(handler, '隐藏时要主动释放，别留一个已经作废的句柄').toMatch(/release\(\)/)
  })

  it('重新申请前先把上一把锁放掉，句柄统一由 ref 管住', () => {
    // 句柄只存在 then 的闭包里时，第二次申请没法释放第一把 → 泄漏且无法收敛
    expect(src).toMatch(/const wakeLockRef = useRef<\(\(\) => void\) \| null>\(null\)/)
    const at = src.indexOf('const acquire =')
    expect(at).toBeGreaterThanOrEqual(0)
    const acquire = src.slice(at, at + 400)
    expect(acquire).toContain('acquireWakeLock()')
    // 重复获取前先释放旧的
    expect(acquire).toMatch(/release\(\)\s*wakeLockRef\.current = fn/)
  })

  it('卸载/离开学习页时释放，且在途请求不会漏锁', () => {
    const at = src.indexOf('const release =')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(src.slice(at, at + 120)).toMatch(/wakeLockRef\.current\?\.\(\)/)
    // effect 清理里必须释放 + 摘监听
    const cleanup = src.slice(src.indexOf('document.removeEventListener'), src.indexOf('}, [route.kind'))
    expect(cleanup).toContain('release()')
    // 异步申请的竞态：拿到句柄时已经离开学习页就当场释放
    expect(src).toContain('if (cancelled) fn?.()')
  })
})
