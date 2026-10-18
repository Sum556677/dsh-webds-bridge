import { defineConfig } from 'vitest/config'

/**
 * 单包结构下的测试配置。
 *
 * 注意 types/ 目录**不可删除**：它是 @deepseek-ai/* 的本地类型垫片，
 * tsconfig 的 paths 与下面的 alias 都依赖它，否则类型检查与测试都会失败。
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/node_modules/**'],
    },
    environmentMatchGlob: [
      ['src/client/**', 'jsdom'],
      ['src/client-entry.ts', 'jsdom'],
      ['src/host/**', 'node'],
      ['src/index.ts', 'node'],
    ],
  },
  resolve: {
    alias: {
      '@deepseek-ai/cordis': '/types/deepseek-ai.d.ts',
      '@deepseek-ai/dsh-host-webserver': '/types/deepseek-ai.d.ts',
      '@deepseek-ai/dsh-client-runtime/client': '/types/deepseek-ai.d.ts',
    },
  },
})
