/**
 * Client 端记忆保存编排：总结 Prompt → DOM 读取 → 1800 字符截断 → Host RPC。
 */

import { activeSessionId, getActiveChatView, runDomTest } from './dom-ops'

export const SUMMARY_PROMPT = `请对以上全部对话内容进行结构化总结，输出格式如下：

## 核心结论
（已达成共识的关键结论，按重要性排列）

## 已确定方案
（已经确定的实现方案、技术选型、设计决策）

## 待解决问题
（尚未解决的疑问、需要进一步讨论的点）

## 关键上下文
（理解后续讨论所必需的背景信息、约束条件、用户偏好）

要求：精炼、准确、不超过 800 字。不要遗漏任何已确定的决策。`

/** 任务书规定的硬上限。 */
export const SUMMARY_LIMIT = 1800

const TRUNCATION_MARKER = '\n\n> （内容超长，已截断）'

export interface TruncatedSummary {
  text: string
  truncated: boolean
  originalChars: number
  finalChars: number
}

/**
 * 超过 limit 时优先完整保留“核心结论 + 已确定方案”，
 * 剩余预算再补“待解决问题 / 关键上下文”，最后附截断标记。
 */
export function truncateSummary(text: string, limit = SUMMARY_LIMIT): TruncatedSummary {
  const originalChars = text.length
  if (originalChars <= limit) {
    return { text, truncated: false, originalChars, finalChars: originalChars }
  }

  const budget = Math.max(0, limit - TRUNCATION_MARKER.length)
  const headingIndex = (title: string) => {
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    // 兼容三种真实形态：`## 核心结论`、`**核心结论**`、以及渲染后 innerText 里只剩纯文本的 `核心结论`。
    const pattern = new RegExp(
      `^\\s*(?:#{1,6}\\s*|\\*\\*\\s*)?${escaped}\\s*(?:\\*\\*)?\\s*$`,
      'mu'
    )
    return text.match(pattern)?.index ?? -1
  }
  const starts = ['核心结论', '已确定方案', '待解决问题', '关键上下文']
    .map((title) => headingIndex(title))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)
  const nextStart = (from: number) => starts.find((index) => index > from) ?? text.length

  const planStart = headingIndex('已确定方案')
  const coreStart = headingIndex('核心结论')
  const anchor = planStart >= 0 ? planStart : coreStart >= 0 ? coreStart : -1
  const mandatoryEnd = anchor >= 0 ? nextStart(anchor) : Math.min(text.length, budget)

  let kept = text.slice(0, mandatoryEnd).trimEnd()

  if (kept.length > budget) {
    // “核心结论 + 已确定方案”本身已超预算：只能硬截。
    kept = kept.slice(0, budget).trimEnd()
  } else {
    const room = budget - kept.length - 2
    if (room > 0) {
      const rest = text.slice(mandatoryEnd).trim()
      if (rest.length > 0) kept = `${kept}\n\n${rest.slice(0, room).trimEnd()}`
    }
  }

  const finalText = kept.trimEnd() + TRUNCATION_MARKER
  return {
    text: finalText,
    truncated: true,
    originalChars,
    finalChars: finalText.length,
  }
}

export interface SaveMemoryResult {
  ok: boolean
  stage?: string
  message?: string
  chars?: number
  originalChars?: number
  truncated?: boolean
  summary?: string
  host?: any
  conversation?: any
  [key: string]: unknown
}

function connectionRpc(ctx: any) {
  const connection = ctx?.get?.('connection', false) ?? ctx?.connection
  const rpc = connection?.rpc
  if (!rpc || typeof rpc.call !== 'function') {
    throw new Error('connection.rpc 不可用：Client 与 Host 的 RPC 通道未挂载')
  }
  return rpc
}

function timeoutSignal(ms = 30000): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof (AbortSignal as any).timeout === 'function'
    ? (AbortSignal as any).timeout(ms)
    : undefined
}

/** 读取一次总结并写入 Host 的 dsh_memory。 */
export async function saveMemory(ctx: any): Promise<SaveMemoryResult> {
  // 保存阶段绝不新建 tab：必须复用刚刚完成问答的那条 webview；同时禁止递归触发自动续接。
  const conversation = await runDomTest(ctx, SUMMARY_PROMPT, {
    reuseOnly: true,
    suppressAutoContinue: true,
  })
  if (!conversation.ok) {
    return {
      ok: false,
      stage: conversation.stage,
      message: conversation.message ?? '总结对话失败',
      conversation,
    }
  }

  const raw = String(conversation.replyMarkdown ?? '').trim()
  if (raw.length === 0) {
    return { ok: false, stage: 'summary', message: 'DeepSeek 返回了空总结', conversation }
  }

  const cut = truncateSummary(raw)

  const host = await saveSummaryToHost(ctx, cut.text, {
    originalChars: cut.originalChars,
    finalChars: cut.finalChars,
    truncated: cut.truncated,
  })

  return {
    ok: true,
    stage: 'saved',
    message: '记忆已写入 Host',
    chars: cut.finalChars,
    originalChars: cut.originalChars,
    truncated: cut.truncated,
    summary: cut.text,
    host,
  }
}

export interface SaveSummaryMeta {
  [key: string]: unknown
}

/**
 * 当前生效的记忆别名。
 * 面板切换后由 index.ts 写入，使"保存记忆"和"执行注入"指向同一个文件，
 * 避免出现"保存到 A、注入读 B"的错位。
 */
let currentMemoryKey = 'progress'

export function getMemoryKey(): string {
  return currentMemoryKey
}

export function setMemoryKey(key: string): void {
  const next = String(key ?? '').trim()
  currentMemoryKey = next.length > 0 ? next : 'progress'
}

/** 通用 RPC 调用：统一信封、统一错误收敛。 */
export async function callWebdsRpc(
  ctx: any,
  endpoint: string,
  payload: Record<string, unknown> = {}
): Promise<any> {
  const rpc = connectionRpc(ctx)
  const response = await rpc.call('/api', 'plugin-rpc/webds', { endpoint, payload }, timeoutSignal())
  if (!response || response.ok !== true) {
    const error = response?.error
    throw new Error(
      `Host ${endpoint} 失败：${String(error?.code ?? 'unknown')} ${String(error?.message ?? '')}`.trim()
    )
  }
  return response.value
}

/** 把已经拿到的总结写入 Host（手动保存与自动续接共用）。 */
export async function saveSummaryToHost(
  ctx: any,
  summary: string,
  meta: SaveSummaryMeta = {}
): Promise<any> {
  const rpc = connectionRpc(ctx)
  const sessionId = activeSessionId()
  const key = getMemoryKey()
  const response = await rpc.call(
    '/api',
    'plugin-rpc/webds',
    {
      endpoint: 'save',
      payload: {
        key,
        summary,
        meta: {
          source: 'chat.deepseek.com',
          sessionId,
          savedAt: new Date().toISOString(),
          ...meta,
        },
      },
    },
    timeoutSignal()
  )

  if (!response || response.ok !== true) {
    const error = response?.error
    throw new Error(
      `Host 保存失败：${String(error?.code ?? 'unknown')} ${String(error?.message ?? '')}`.trim()
    )
  }
  // Host 会规范化别名并返回实际写入的 key，回写以保持一致
  const savedKey = String(response.value?.key ?? key)
  setMemoryKey(savedKey)
  return response.value
}

export interface ExecuteMemoryResult {
  ok: boolean
  stage?: string
  message?: string
  sessionId?: string
  host?: any
  [key: string]: unknown
}

/**
 * 读取 Host 的 progress.md，并作为一条用户消息投递到当前主会话。
 * sessionId 来自右侧栏根节点的 data-sidebar-right-session（官方 sidebar-right 自己就用它）。
 */
export async function executeMemory(ctx: any): Promise<ExecuteMemoryResult> {
  const view = getActiveChatView()
  const sessionId = activeSessionId(view)
  if (sessionId.length === 0) {
    return {
      ok: false,
      stage: 'session',
      message:
        '无法确定当前主会话 ID：请先执行 __webds_test__() / __webds_open__() 打开右侧 Browser tab，让侧栏标记 data-sidebar-right-session',
    }
  }

  const rpc = connectionRpc(ctx)
  const key = getMemoryKey()
  const response = await rpc.call(
    '/api',
    'plugin-rpc/webds',
    { endpoint: 'execute', payload: { sessionId, key } },
    timeoutSignal()
  )

  if (!response || response.ok !== true) {
    const error = response?.error
    throw new Error(
      `Host 执行注入失败：${String(error?.code ?? 'unknown')} ${String(error?.message ?? '')}`.trim()
    )
  }

  return {
    ok: true,
    stage: 'executed',
    message: `已把 ${key} 作为用户消息投递到主会话`,
    sessionId,
    host: response.value,
  }
}
