// 桌面端测试配置。
//
// 存在的唯一理由：把这个仓库里的**移动端子工程**排除在桌面端测试之外。
// mobile-android/ 是独立 npm 工程（自己的 vitest 配置与用例），而 vitest 默认 include
// 是 `**/*.{test,spec}.?(c|m)[jt]s?(x)`——根目录跑 `npm test` 会把它的用例一并收进来，
// 两边的环境与依赖都不同，混在一起跑只会得到误导性的红绿。
//
// 其余一切照旧：用 vitest 默认（include 默认模式、environment 默认 node，
// renderer 的 jsdom 用例靠文件头 `@vitest-environment jsdom` 声明）。
import { defineConfig, defaultExclude } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [...defaultExclude, 'mobile-android/**']
  }
})
