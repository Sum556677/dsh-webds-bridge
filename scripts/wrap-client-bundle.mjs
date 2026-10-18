#!/usr/bin/env node
/**
 * Dsh Webds Bridge — Client Bundle Wrapper
 *
 * tsdown 不能直接输出 DSH 需要的自注册头，所以在构建后把 dist/client.cjs
 * 包成 DSH 的官方格式：
 *
 *   window.__ModuleLoader__.load({
 *     id: "<package-name>",
 *     factory: (require) => { ...CJS body...; return module.exports }
 *   });
 *
 * id 必须是**包名**：dsh-client-modules 按包名扫描 loader 条目，再按
 * exports["./client"] 取到本文件，最后用这个 id 在浏览器侧匹配模块。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-webds-bridge'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE_PATH = join(ROOT, 'dist', 'client.cjs')

if (!existsSync(BUNDLE_PATH)) {
  console.error(`[wrap-client-bundle] Bundle not found: ${BUNDLE_PATH}`)
  console.error('Run the tsdown build first.')
  process.exit(1)
}

const raw = readFileSync(BUNDLE_PATH, 'utf8').trim()
if (raw.includes('window.__ModuleLoader__.load(')) {
  console.warn('[wrap-client-bundle] Bundle already wrapped, skipping')
  process.exit(0)
}

// 去掉源映射尾注释，避免包装后映射目标错位
const body = raw.replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*$/u, '')

const wrapped = [
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(PACKAGE_NAME)},`,
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  '    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  body
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n'),
  '    return module.exports;',
  '  }',
  '});',
  '',
].join('\n')

writeFileSync(BUNDLE_PATH, wrapped)
console.log(`[wrap-client-bundle] Wrapped: ${BUNDLE_PATH}`)
