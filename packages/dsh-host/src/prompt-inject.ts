/**
 * 把记忆文件作为动态 system-prompt context 注入。
 *
 * 说明：DSH 0.32 系的 ctx.systemPrompt.context() 接收
 *   { name, order, text(context) }
 * 而不是 { render }；order 必须是有限数字。context 会作为 sourced
 * user-role snapshot 进入模型历史（模型能读到），不是拼进固定开场白。
 *
 * 多对话：注入**当前选中的那个别名文件**（store.fileFor(key)），
 * 而不是固定 progress.md；切换别名或根目录后调用 setTarget() 即可生效。
 *
 * 性能：render 用 mtime 缓存，文件未变化时不重复读盘。
 */

import { readFileSync, statSync } from 'node:fs'

import type { Context } from '@deepseek-ai/cordis'

import type { MemoryStore } from './memory-store'

export const PROMPT_CONTEXT_NAME = 'webds-bridge:progress'
/** 外部 context 可用任意有限 order；900 使其排在大多数运行时上下文之后。 */
export const PROMPT_CONTEXT_ORDER = 900

export interface PromptInjectionHandle {
  /** 当前缓存内容（诊断/测试用）。 */
  readCached(): string
  /** 强制失效缓存。 */
  invalidate(): void
  /** 切换注入目标（别名变化或根目录迁移后调用）。 */
  setTarget(store: MemoryStore, key: string): void
  /** 当前注入目标路径。 */
  currentPath(): string
}

export function installPromptInjection(
  ctx: Context,
  store: MemoryStore,
  key = 'progress'
): PromptInjectionHandle {
  let progressPath = store.fileFor(key)
  let title = key

  let cachedMtime = Number.NaN
  let cachedText = ''
  let hasCache = false

  const reset = () => {
    hasCache = false
    cachedMtime = Number.NaN
    cachedText = ''
  }

  const render = (): string => {
    try {
      const stat = statSync(progressPath)
      if (hasCache && cachedMtime === stat.mtimeMs) return cachedText

      const content = readFileSync(progressPath, 'utf8')
      cachedMtime = stat.mtimeMs
      hasCache = true
      cachedText =
        content.trim().length === 0
          ? ''
          : `## 当前讨论进度（来自网页版 DeepSeek 对话 · ${title}）\n\n${content}`
      return cachedText
    } catch {
      reset()
      return ''
    }
  }

  ctx.inject(['systemPrompt'], (scope) => {
    ;(scope as any).systemPrompt.context({
      name: PROMPT_CONTEXT_NAME,
      order: PROMPT_CONTEXT_ORDER,
      text: render,
    })
    ctx.logger.info(
      `[webds] system prompt context registered: ${PROMPT_CONTEXT_NAME} (order=${PROMPT_CONTEXT_ORDER})`
    )
  })

  return {
    readCached: () => cachedText,
    invalidate: reset,
    setTarget: (nextStore: MemoryStore, nextKey: string) => {
      const nextPath = nextStore.fileFor(nextKey)
      if (nextPath === progressPath) {
        reset()
        return
      }
      progressPath = nextPath
      title = nextKey
      reset()
    },
    currentPath: () => progressPath,
  }
}
