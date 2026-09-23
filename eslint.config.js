// ESLint flat config。目标：拦真问题（未用变量、未定义引用、误用），不搞风格洁癖
// —— 格式交给编辑器/个人习惯，避免无意义的全量 churn。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // 构建产物、前端 SPA（经 tests/dashboard-spa.test.ts 与 tests/spa-*.test.ts
    // 单独守卫）、依赖
    ignores: ['dist/**', 'node_modules/**', 'public/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // 本项目大量使用 any 承接上游无契约的 wire 事件 —— 有意为之
      '@typescript-eslint/no-explicit-any': 'off',
      // 以 _ 开头的参数/变量视为有意忽略
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // 防御式编程里 "catch {}" 是常态
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // CI 会执行这些工具脚本（.github/workflows/release.yml 就调它），所以必须过
    // lint 而不是 ignore —— 只在 CI 里跑、又没有任何静态检查的文件，
    // 等于把第一次运行留到线上。
    // 仓库根的三个 .mjs（bench-models / purge-test-usage / usage-history-io）同样是
    // README 让维护者手工运行的工具，理由一致，此前却被根级 `*.mjs` 一条忽略漏掉了。
    files: ['scripts/**/*.mjs', '*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        console: 'readonly', process: 'readonly', Buffer: 'readonly', URL: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        // Node 18 起为全局，但 eslint 的默认 ecmaVersion 不会自动带上
        fetch: 'readonly', AbortSignal: 'readonly', AbortController: 'readonly',
      },
    },
  },
);
