import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/__tests__/**/*.test.ts'],
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/node_modules/**'],
    },
    environmentMatchGlob: [
      ['packages/dsh-client/**', 'jsdom'],
      ['packages/dsh-host/**', 'node'],
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
