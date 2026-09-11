// ESLint 平面配置（ESLint 10）：typescript-eslint 推荐集 + react-hooks + 浏览器/Node 全局。
// 定位是查真问题（未用变量、hook 依赖缺失等）；代码风格归 Prettier 管，这里不放格式规则。
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  // mobile-android/ 是独立子工程（自己的 package.json 与 lint 脚本），根目录的 lint 不碰它：
  // 它的 tsconfig/lib 与桌面端不同，混在一起报的问题归属不清
  { ignores: ['**/node_modules/**', 'out/**', 'release/**', 'dist/**', 'mobile-android/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'scripts/**/*.{js,mjs}', 'electron.vite.config.ts'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node }
    },
    rules: {
      // 行序列化的解构丢弃位（const { deckId: _d, ...content } = c）按下划线前缀豁免
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }
      ]
    }
  },
  {
    // postinstall 脚本必须是 CJS（package.json 无 "type": "module"，node 直接跑 .js），
    // require 是有意写法不是迁移欠账
    files: ['scripts/*.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    files: ['src/renderer/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      // 依赖数组为告警级：调度页有刻意只跑一次的 effect
      'react-hooks/exhaustive-deps': 'warn',
      // React Compiler 时代的新建议（compiler 系规则）。现有组件模式是刻意取舍
      // （竞态防护/外部时刻读取/防抖定位），改动要重写组件行为，超出 lint 接入边界；
      // 降为 warn 保留提示，不挡提交
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn'
    }
  }
)
