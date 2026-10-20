// 移动端构建配置：Vite + React，并把桌面端的 core / shared 作为源码别名直接引用（同仓共享，不做拷贝）。
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

/** 构建戳：版本号 + 短 commit + 打包时间。
 *
 * 为什么需要它：安卓包的 versionCode 恒为 1（覆盖安装要靠它不变），装到手机上之后
 * 界面上没有任何东西能区分「这是哪次打包的」——历史上就吃过"以为装了修复、其实跑的是旧包"的亏。
 * 这三个值写进设置页「关于」，升级完看一眼就知道换没换。 */
function buildStamp(): { version: string; hash: string; at: string } {
  const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string
  let hash = 'unknown'
  try {
    hash = execSync('git rev-parse --short HEAD', { cwd: dir('.'), encoding: 'utf8' }).trim()
  } catch {
    // 没有 git 元数据（从 tarball 构建）时不该让打包失败，退化成 unknown
  }
  return { version, hash, at: new Date().toISOString() }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __MIKI_BUILD__: JSON.stringify(buildStamp())
  },
  resolve: {
    alias: {
      '@core': dir('../src/core'),
      '@shared': dir('../src/shared'),
      '@mobile': dir('src/mobile'),
      // 桌面端源码：真实工作区对账测试要直接调桌面端的 WorkspaceService
      '@desktop': dir('../src'),
      '@ui': dir('src/ui')
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 移动端 WebView 目标：Android 7+ 自带的 System WebView 已足够新，不必为老引擎降级到 ES5
    target: 'es2020'
  },
  test: {
    // core 与移动版 workspace 都是纯逻辑，node 环境即可（不需要真机、不需要 jsdom）
    environment: 'node',
    // 与桌面端同一套命名习惯：*.spec.ts
    include: ['src/**/*.spec.ts'],
    exclude: ['node_modules/**', 'android/**', 'dist/**']
  }
})
