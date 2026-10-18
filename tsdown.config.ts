import { defineConfig } from 'tsdown'

/**
 * 单包构建：一个 npm 包同时产出 Host 与 Client 两端。
 *
 *   dist/index.js    → Host 插件（ESM），package.json 的 main / exports["."]
 *   dist/client.cjs  → 浏览器 bundle（CJS，自注册），package.json 的 exports["./client"]
 */
export default defineConfig([
  // Host 侧（ESM）
  {
    entry: ['src/index.ts'],
    outDir: 'dist',
    format: 'esm',
    target: 'es2024',
    external: ['@deepseek-ai/*'],
  },
  // Client 侧（CJS）—— 构建后由 scripts/wrap-client-bundle.mjs 包装自注册头
  {
    entry: { client: 'src/client-entry.ts' },
    outDir: 'dist',
    format: 'cjs',
    target: 'es2024',
    // React 由 DSH 的 ModuleLoader 在运行时注入（factory(require)），必须 external：
    // 否则会打进产物出现两份 React，hooks 直接失效。
    external: ['react'],
  },
])
