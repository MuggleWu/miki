// 移动端构建配置：Vite + React，并把桌面端的 core / shared 作为源码别名直接引用（同仓共享，不做拷贝）。
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const dir = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@core': dir('../src/core'),
      '@shared': dir('../src/shared'),
      '@mobile': dir('src/mobile'),
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
