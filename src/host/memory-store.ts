/**
 * Host 端记忆存储：按 key 命名的记忆文件 + history 归档 + mtime 缓存。
 *
 * 目录布局：
 *   <root>/config.json            存储根的持久化配置（panel 写入）
 *   <root>/progress.md            默认记忆（别名 = "progress"）
 *   <root>/projects/xxx.md        自定义别名（防多对话互相覆盖）
 *   <root>/history/               归档
 *
 * 默认根目录：$DSH_WEBDS_MEMORY_DIR ＞ <root>/config.json ＞ $DSH_HOME/dsh_memory
 * 该模块只依赖 Node 内置模块，不引用任何 @deepseek-ai 运行时包。
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_MEMORY_KEY = 'progress'
export const CONFIG_FILE = 'config.json'
export const HISTORY_DIR = 'history'
export const HISTORY_LIMIT = 20

/** 别名文件所在的子目录，与默认的 progress.md 分开，避免语义混淆。 */
export const ALIAS_DIR = 'projects'

export interface MemorySaveResult {
  path: string
  key: string
  bytes: number
  archivedPath?: string
  pruned: number
  mtimeMs: number
  createdAt: string
}

export interface MemoryReadResult {
  path: string
  key: string
  content: string
  mtimeMs: number
  cached: boolean
}

/** 根目录来源，用于 UI 提示（env 优先级最高且不可被面板覆盖）。 */
export type RootSource = 'env' | 'config' | 'default'

export interface StoreConfig {
  memoryDir?: string
  /** 上次保存使用的别名，面板用它回填输入框。 */
  lastKey?: string
}

/** 默认记忆根目录：$DSH_HOME/dsh_memory（环境变量优先）。 */
export function defaultMemoryDir(): string {
  const explicit = process.env.DSH_WEBDS_MEMORY_DIR
  if (explicit && explicit.trim().length > 0) return path.resolve(explicit)
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(home, 'dsh_memory')
}

/**
 * 规范化记忆别名，同时充当**安全边界**：别名直接参与拼路径，
 * 必须挡住 `../`、绝对路径、盘符和保留字符，否则等于任意文件写入。
 * @param raw 用户输入。
 * @returns 安全的相对路径片段（可含 `/` 形成子目录）。
 */
export function normalizeMemoryKey(raw: unknown): string {
  const text = String(raw ?? '').trim()
  if (text.length === 0) throw new Error('记忆别名不能为空')

  // 绝对路径直接拒绝（不要"归一化后放行"：'/etc/passwd' 会变成 'etc/passwd'，
  // 虽然落在 root 下不致命，但语义上等于用户以为在写系统路径，必须报错说清）。
  if (/^[\\/]/u.test(text)) throw new Error('记忆别名不能以斜杠开头（请用相对路径）')
  if (/^[a-zA-Z]:/u.test(text)) throw new Error('记忆别名不能是盘符路径')

  const normalized = text
    .replace(/\\/gu, '/')
    .replace(/\.md$/i, '')
    .replace(/\/{2,}/gu, '/')
    .replace(/^\.\//u, '')

  const segments = normalized.split('/').filter((segment) => segment.length > 0)
  if (segments.length === 0) throw new Error('记忆别名不能为空')
  if (segments.length > 4) throw new Error('记忆别名最多 4 层目录')
  for (const segment of segments) {
    if (segment === '.' || segment === '..') throw new Error('记忆别名不能包含 . 或 ..')
    // 只允许中英文、数字、- _ 与空格；拒绝 Windows 保留字符与路径分隔符
    if (!/^[\p{L}\p{N}_\- .]+$/u.test(segment)) {
      throw new Error(`记忆别名含非法字符：${segment}（仅允许中英文、数字、- _ 空格）`)
    }
    if (/[.\s]$/u.test(segment)) throw new Error(`记忆别名不能以点或空格结尾：${segment}`)
  }
  if (normalized.length > 96) throw new Error('记忆别名过长（最多 96 字符）')
  return segments.join('/')
}

function timestamp(date = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-` +
    `${pad(date.getMilliseconds(), 3)}`
  )
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/** 先写临时文件再替换，避免半截文件；Windows 上 rename 覆盖失败时退回 remove+rename。 */
async function writeAtomic(file: string, content: string): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(temporary, content, 'utf8')
  try {
    await fs.rename(temporary, file)
  } catch {
    await fs.rm(file, { force: true })
    await fs.rename(temporary, file)
  }
}

export class MemoryStore {
  readonly dir: string
  readonly source: RootSource
  private cache: { mtimeMs: number; size: number; content: string; path: string } | undefined

  constructor(dir = defaultMemoryDir(), source: RootSource = 'default') {
    this.dir = path.resolve(dir)
    this.source = source
  }

  get configPath(): string {
    return path.join(this.dir, CONFIG_FILE)
  }

  get historyPath(): string {
    return path.join(this.dir, HISTORY_DIR)
  }

  /** 默认记忆（别名 progress）的绝对路径。 */
  get progressPath(): string {
    return this.fileFor(DEFAULT_MEMORY_KEY)
  }

  /** 别名 → 绝对路径。progress 保持根目录直放，其余进入 projects/。 */
  fileFor(key: string): string {
    const normalized = normalizeMemoryKey(key)
    if (normalized === DEFAULT_MEMORY_KEY) {
      return path.join(this.dir, `${DEFAULT_MEMORY_KEY}.md`)
    }
    // 用户已经写了 projects/ 前缀时不再重复拼接（否则会变成 projects/projects/...）
    const prefix = `${ALIAS_DIR}/`
    const relative = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized
    return path.join(this.dir, ALIAS_DIR, `${relative}.md`)
  }

  /** 读取存储根配置（不存在则返回空对象）。 */
  async readConfig(): Promise<StoreConfig> {
    try {
      const raw = await fs.readFile(this.configPath, 'utf8')
      const data = JSON.parse(raw) as Record<string, unknown>
      const config: StoreConfig = {}
      if (typeof data.memoryDir === 'string' && data.memoryDir.trim().length > 0) {
        config.memoryDir = data.memoryDir
      }
      if (typeof data.lastKey === 'string' && data.lastKey.trim().length > 0) {
        config.lastKey = data.lastKey
      }
      return config
    } catch {
      return {}
    }
  }

  async writeConfig(patch: StoreConfig): Promise<StoreConfig> {
    const current = await this.readConfig()
    const next: StoreConfig = { ...current, ...patch }
    if (next.memoryDir !== undefined && next.memoryDir.trim().length === 0) delete next.memoryDir
    if (next.lastKey !== undefined && next.lastKey.trim().length === 0) delete next.lastKey
    await fs.mkdir(this.dir, { recursive: true })
    await writeAtomic(this.configPath, `${JSON.stringify(next, undefined, 2)}\n`)
    return next
  }

  /** 列出所有记忆文件（默认 + projects/ 下的别名），用于面板下拉。 */
  async listMemories(): Promise<Array<{ key: string; path: string; bytes: number; mtimeMs: number }>> {
    const out: Array<{ key: string; path: string; bytes: number; mtimeMs: number }> = []

    const collect = async (dir: string, prefix: string) => {
      let entries: import('node:fs').Dirent[] = []
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          // history/ 是归档目录，不是可选记忆，跳过
          if (prefix === '' && entry.name === HISTORY_DIR) continue
          await collect(full, `${prefix}${entry.name}/`)
          continue
        }
        if (!entry.name.toLowerCase().endsWith('.md')) continue
        if (entry.name.includes('.tmp-')) continue
        try {
          const stat = await fs.stat(full)
          out.push({
            key: prefix + entry.name.replace(/\.md$/iu, ''),
            path: full,
            bytes: stat.size,
            mtimeMs: stat.mtimeMs,
          })
        } catch {
          /* 跳过读不到的文件 */
        }
      }
    }

    // 从根目录递归即可覆盖 projects/ 与嵌套子目录（history/ 已在上面排除）
    await collect(this.dir, '')

    // 去掉根目录扫描时误收的 projects/ 递归结果（collect 对根目录也会递归进子目录），
    // 统一重写 key：根目录下的 projects/xxx 归并成 projects/xxx。
    const seen = new Map<string, (typeof out)[number]>()
    for (const item of out) {
      const relative = path.relative(this.dir, item.path).replace(/\\/gu, '/')
      const key = relative.replace(/\.md$/iu, '')
      if (!seen.has(key)) seen.set(key, { ...item, key })
    }
    const list = [...seen.values()]
    list.sort((left, right) => right.mtimeMs - left.mtimeMs)
    return list
  }

  /** 读取指定别名的记忆。命中 mtime+size 缓存时不再读盘。 */
  async read(key = DEFAULT_MEMORY_KEY): Promise<MemoryReadResult> {
    const file = this.fileFor(key)
    const normalized = normalizeMemoryKey(key)
    if (!(await exists(file))) {
      return { path: file, key: normalized, content: '', mtimeMs: 0, cached: false }
    }

    const stat = await fs.stat(file)
    if (
      this.cache !== undefined &&
      this.cache.path === file &&
      this.cache.mtimeMs === stat.mtimeMs &&
      this.cache.size === stat.size
    ) {
      return {
        path: file,
        key: normalized,
        content: this.cache.content,
        mtimeMs: stat.mtimeMs,
        cached: true,
      }
    }

    const content = await fs.readFile(file, 'utf8')
    this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, content, path: file }
    return { path: file, key: normalized, content, mtimeMs: stat.mtimeMs, cached: false }
  }

  /**
   * 归档旧内容并覆盖写新总结。
   * @param summary Client 端已截断的总结文本。
   * @param key 记忆别名；默认 progress.md。
   */
  async save(summary: string, key = DEFAULT_MEMORY_KEY): Promise<MemorySaveResult> {
    const content = String(summary ?? '')
    if (content.trim().length === 0) throw new Error('memory summary is empty')

    const normalized = normalizeMemoryKey(key)
    const file = this.fileFor(normalized)
    // 别名可能带子目录，先把父目录建出来
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.mkdir(this.historyPath, { recursive: true })

    let archivedPath: string | undefined
    if (await exists(file)) {
      const previous = await fs.readFile(file, 'utf8')
      if (previous.trim().length > 0) {
        // 归档名带上别名，避免不同别名的历史互相覆盖
        const stem = normalized.replace(/\//gu, '__')
        archivedPath = path.join(this.historyPath, `${stem}-${timestamp()}.md`)
        await fs.writeFile(archivedPath, previous, 'utf8')
      }
    }

    const createdAt = new Date().toISOString()
    const body = content.endsWith('\n') ? content : `${content}\n`
    await writeAtomic(file, body)
    const pruned = await this.pruneHistory()

    const stat = await fs.stat(file)
    this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, content: body, path: file }

    return {
      path: file,
      key: normalized,
      bytes: Buffer.byteLength(body, 'utf8'),
      ...(archivedPath === undefined ? {} : { archivedPath }),
      pruned,
      mtimeMs: stat.mtimeMs,
      createdAt,
    }
  }

  /** 只保留最近 HISTORY_LIMIT 个归档，返回删除数量。 */
  async pruneHistory(): Promise<number> {
    let entries: string[] = []
    try {
      entries = (await fs.readdir(this.historyPath)).filter((name) => name.endsWith('.md'))
    } catch {
      return 0
    }
    entries.sort()

    const excess = entries.length - HISTORY_LIMIT
    if (excess <= 0) return 0

    for (const name of entries.slice(0, excess)) {
      await fs.rm(path.join(this.historyPath, name), { force: true })
    }
    return excess
  }
}

export function createMemoryStore(dir?: string, source?: RootSource): MemoryStore {
  return new MemoryStore(dir, source)
}

/** 从根目录配置解析最终使用的目录与来源（env 优先且不可覆盖）。 */
export async function resolveMemoryRoot(): Promise<{
  dir: string
  source: RootSource
  envDir: string | undefined
  config: StoreConfig
}> {
  const envDir = process.env.DSH_WEBDS_MEMORY_DIR?.trim()
  const baseDir = envDir ? path.resolve(envDir) : defaultMemoryDir()
  // 指针文件始终在**默认位置**（$DSH_HOME/dsh_memory/config.json），
  // 不论当前数据存在哪：这样换过目录之后，下次启动仍能找到那个指针。
  const pointer = new MemoryStore(baseDir, envDir ? 'env' : 'default')
  const config = await pointer.readConfig()
  if (envDir) return { dir: baseDir, source: 'env', envDir, config }

  const configured = config.memoryDir?.trim()
  if (configured && configured.length > 0) {
    // 指针指向的目录自身也可能有 config.json（lastKey 等），以它为准覆盖
    const target = new MemoryStore(path.resolve(configured), 'config')
    const targetConfig = await target.readConfig()
    return {
      dir: target.dir,
      source: 'config',
      envDir,
      config: { ...targetConfig, memoryDir: target.dir },
    }
  }
  return { dir: baseDir, source: 'default', envDir, config }
}
