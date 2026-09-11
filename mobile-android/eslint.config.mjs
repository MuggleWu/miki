// 移动端 ESLint 平面配置（ESLint 10）：与桌面端同一套口径（typescript-eslint 推荐集 + react-hooks）。
// 风格归 Prettier 管（沿用仓库根的 .prettierrc.json），这里只查真问题。
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['**/node_modules/**', 'dist/**', 'android/**', '**/*.d.ts'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', '*.ts'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }
      ]
    }
  },
  {
    // 自定义 hook 常常写在 .ts 里（不带 JSX），所以这一档要覆盖 ui 下的两种扩展名，
    // 否则 .ts 里的 hook 既查不到问题，写 eslint-disable 还会报「规则未定义」
    files: ['src/ui/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      // 与桌面端一致：编译器系建议降为 warn，不挡提交
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn'
    }
  }
)
