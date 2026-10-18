#!/usr/bin/env node
/**
 * Dsh Webds Bridge - Auto Register Script (Cross-platform)
 *
 * Usage: node scripts/auto-register.js
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = join(__dirname, '..')

// DSH profile directory (honors DSH_HOME, defaults to ~/.dsh)
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DSH_PROFILE_DIR = join(DSH_HOME, 'profiles', 'web')
const PROFILE_PATCH_PATH = join(DSH_PROFILE_DIR, 'cordis.patch.yml')

// Client plugin loader id (keep in sync with cordis.patch.yml / wrap-client-bundle.mjs)
const CLIENT_LOADER_ID = 'dsh-webds-bridge-client'

console.log('========================================')
console.log('Dsh Webds Bridge - Auto Register')
console.log('========================================')
console.log('')
console.log(`Project root: ${PROJECT_ROOT}`)
console.log('')

// Check dsh command
try {
  execSync('dsh --version', { stdio: 'ignore' })
} catch {
  console.error('[ERROR] dsh command not found, please install DeepSeek Harness')
  console.error('Install: npm install -g @deepseek-ai/dsh')
  process.exit(1)
}

// Check plugin directories
const hostDir = join(PROJECT_ROOT, 'packages', 'dsh-host')
const clientDir = join(PROJECT_ROOT, 'packages', 'dsh-client')

if (!existsSync(hostDir)) {
  console.error('[ERROR] Host plugin directory not found: packages/dsh-host')
  process.exit(1)
}

if (!existsSync(clientDir)) {
  console.error('[ERROR] Client plugin directory not found: packages/dsh-client')
  process.exit(1)
}

/**
 * Idempotently ensure the client plugin loader entry exists in the profile's
 * cordis.patch.yml.
 *
 * Why: `dsh plugin add` only forwards to pnpm and maintains package.json's
 * dependencies + dsh.profile.bundles. A client plugin declares only dsh.client
 * (no dsh.bundle), so it never joins bundles and must be inserted into the
 * profile patch manually for dsh-client-modules to wire it into
 * window.__DSH_BOOT__.
 *
 * Target format (same as a hand-written entry):
 *   - insert:
 *       - id: dsh-webds-bridge-client
 *         name: dsh-webds-bridge-client
 */
function ensureClientPatchEntry() {
  console.log('[5/6] Verifying profile patch (client plugin entry)...')

  // Idempotent: skip when the loader entry already exists
  const existing = existsSync(PROFILE_PATCH_PATH)
    ? readFileSync(PROFILE_PATCH_PATH, 'utf8')
    : ''
  if (new RegExp(`- id: ${CLIENT_LOADER_ID}\\b`).test(existing)) {
    console.log('[SKIP] cordis.patch.yml already contains the client plugin entry')
    return
  }

  const entry = [
    '',
    '# Client plugin (idempotently maintained by auto-register script):',
    '- insert:',
    `    - id: ${CLIENT_LOADER_ID}`,
    `      name: ${CLIENT_LOADER_ID}`,
    '',
  ].join('\n')

  // Directory fallback (normally dsh plugin add initializes the profile)
  mkdirSync(DSH_PROFILE_DIR, { recursive: true })

  // Join and write back as a whole, avoiding appendFileSync newline edge cases
  const updated = existing === '' || existing.endsWith('\n')
    ? existing + entry
    : existing + '\n' + entry
  writeFileSync(PROFILE_PATCH_PATH, updated)
  console.log(`[OK] Client plugin entry written: ${PROFILE_PATCH_PATH}`)
}

// Install dependencies
console.log('[1/6] Installing dependencies...')
try {
  execSync('pnpm install', { cwd: PROJECT_ROOT, stdio: 'inherit' })
  console.log('[OK] Dependencies installed')
  console.log('')
} catch {
  console.error('[ERROR] Install failed')
  process.exit(1)
}

// Build plugins
console.log('[2/6] Building plugins...')
try {
  execSync('pnpm build', { cwd: PROJECT_ROOT, stdio: 'inherit' })
  console.log('[OK] Plugins built successfully')
  console.log('')
} catch {
  console.error('[ERROR] Build failed')
  process.exit(1)
}

// Install host plugin
console.log('[3/6] Installing host plugin...')
try {
  execSync(`dsh plugin --profile web add "${hostDir}"`, { stdio: 'inherit' })
  console.log('[OK] Host plugin installed successfully')
  console.log('')
} catch {
  console.error('[ERROR] Failed to install host plugin')
  process.exit(1)
}

// Install client plugin
console.log('[4/6] Installing client plugin...')
try {
  execSync(`dsh plugin --profile web add "${clientDir}"`, { stdio: 'inherit' })
  console.log('[OK] Client plugin installed successfully')
  console.log('')
} catch {
  console.error('[ERROR] Failed to install client plugin')
  process.exit(1)
}

// Idempotently write the client plugin patch entry (core fix: ensures the
// client is always mounted by dsh-client-modules)
ensureClientPatchEntry()

// Done
console.log('[6/6] Registration completed')
console.log('')
console.log('========================================')
console.log('Plugin registration successful!')
console.log('========================================')
console.log('')
console.log('Start DSH:')
console.log('  dsh web')
console.log('')
console.log('Note: Restart DSH after installation')
console.log('========================================')
