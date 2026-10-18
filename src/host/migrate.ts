/**
 * 记忆目录迁移：把旧根下的 progress.md、projects/ 与 history/ 复制到新根，
 * 逐文件做**大小 + 内容哈希**校验，全部通过后才写入新根配置。
 *
 * 安全原则：
 *   - 只复制、不删除旧目录（用户可自行清理，避免迁移失败造成数据丢失）；
 *   - 目标已存在同名文件时不覆盖，而是跳过并记入 skipped，交由用户判断；
 *   - 任一文件校验失败 → 整体报错，不写配置。
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { CONFIG_FILE, HISTORY_DIR, ALIAS_DIR } from './memory-store'

export interface MigrateFileResult {
  relative: string
  bytes: number
  copied: boolean
  skipped?: 'exists' | 'same'
  verified: boolean
}

export interface MigrateResult {
  ok: boolean
  from: string
  to: string
  files: MigrateFileResult[]
  copied: number
  skipped: number
  failed: string[]
  configWritten: boolean
}

async function sha256(file: string): Promise<string> {
  const buffer = await fs.readFile(file)
  return createHash('sha256').update(buffer).digest('hex')
}

async function walkMd(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  let entries: import('node:fs').Dirent[] = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...(await walkMd(path.join(dir, entry.name), relative)))
      continue
    }
    if (!entry.name.toLowerCase().endsWith('.md')) continue
    if (entry.name.includes('.tmp-')) continue
    out.push(relative)
  }
  return out
}

/** 收集需要迁移的相对路径：根下 .md（不含 config.json）+ projects/** + history/**。 */
async function collect(from: string): Promise<string[]> {
  const rels: string[] = []
  let rootEntries: import('node:fs').Dirent[] = []
  try {
    rootEntries = await fs.readdir(from, { withFileTypes: true })
  } catch {
    return rels
  }
  for (const entry of rootEntries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && !entry.name.includes('.tmp-')) {
      rels.push(entry.name)
    }
  }
  rels.push(...(await walkMd(path.join(from, ALIAS_DIR), ALIAS_DIR)))
  rels.push(...(await walkMd(path.join(from, HISTORY_DIR), HISTORY_DIR)))
  return rels
}

/**
 * 复制并校验。
 * @param from 旧根目录。
 * @param to 新根目录（必须与 from 不同）。
 * @param writeConfig 全部成功后把 memoryDir 写入新根的 config.json。
 */
export async function migrateMemoryDir(
  from: string,
  to: string,
  writeConfig = true
): Promise<MigrateResult> {
  const source = path.resolve(from)
  const target = path.resolve(to)

  if (source === target) {
    throw new Error('新旧目录相同，无需迁移')
  }
  if (!(await fs.stat(source).then(() => true).catch(() => false))) {
    throw new Error(`旧目录不存在：${source}`)
  }
  // 禁止把新目录放进旧目录里（会导致自我复制）
  const relative = path.relative(source, target)
  if (relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    throw new Error('新目录不能位于旧目录内部')
  }

  const rels = await collect(source)
  const files: MigrateFileResult[] = []
  const failed: string[] = []
  let copied = 0
  let skipped = 0

  for (const relativePath of rels) {
    const fromFile = path.join(source, relativePath)
    const toFile = path.join(target, relativePath)
    try {
      const fromStat = await fs.stat(fromFile)
      const fromHash = await sha256(fromFile)

      const targetExists = await fs.stat(toFile).then(() => true).catch(() => false)
      if (targetExists) {
        const toHash = await sha256(toFile)
        if (toHash === fromHash) {
          files.push({ relative: relativePath, bytes: fromStat.size, copied: false, skipped: 'same', verified: true })
          skipped += 1
        } else {
          files.push({ relative: relativePath, bytes: fromStat.size, copied: false, skipped: 'exists', verified: false })
          skipped += 1
        }
        continue
      }

      await fs.mkdir(path.dirname(toFile), { recursive: true })
      await fs.copyFile(fromFile, toFile)

      const toStat = await fs.stat(toFile)
      const toHash = await sha256(toFile)
      const verified = toStat.size === fromStat.size && toHash === fromHash
      if (!verified) {
        failed.push(relativePath)
        files.push({ relative: relativePath, bytes: fromStat.size, copied: true, verified: false })
        continue
      }
      files.push({ relative: relativePath, bytes: fromStat.size, copied: true, verified: true })
      copied += 1
    } catch (error) {
      failed.push(`${relativePath}: ${String((error as any)?.message ?? error)}`)
    }
  }

  let configWritten = false
  if (failed.length === 0 && writeConfig) {
    await fs.mkdir(target, { recursive: true })
    const configPath = path.join(target, CONFIG_FILE)
    let existing: Record<string, unknown> = {}
    try {
      existing = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>
    } catch {
      existing = {}
    }
    const next = { ...existing, memoryDir: target }
    const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`
    await fs.writeFile(tmp, `${JSON.stringify(next, undefined, 2)}\n`, 'utf8')
    await fs.rm(configPath, { force: true }).catch(() => undefined)
    await fs.rename(tmp, configPath)
    configWritten = true
  }

  return {
    ok: failed.length === 0,
    from: source,
    to: target,
    files,
    copied,
    skipped,
    failed,
    configWritten,
  }
}
