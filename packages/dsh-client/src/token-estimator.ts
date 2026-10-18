/**
 * 本地 Token 估算器 + 阈值配置。
 *
 * 规则：中文按 字符数 / 1.5，其他字符（英文/符号）按 字符数 / 4，混合文本按字符类别加权。
 * 这是估算，不是分词器；用于自动续接的阈值判断足够。
 */

/** 默认上下文阈值。 */
export const DEFAULT_TOKEN_THRESHOLD = 80000

const STORAGE_KEY = 'webds.tokenThreshold'

/** CJK（中日韩）字符范围。 */
const CJK_PATTERN =
  /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/u

/** 估算一段文本的 token 数。 */
export function estimateTokens(text: string): number {
  const value = String(text ?? '')
  if (value.length === 0) return 0

  let cjk = 0
  let other = 0
  for (const char of value) {
    if (CJK_PATTERN.test(char)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk / 1.5 + other / 4)
}

let currentTokens = 0
/** 内存级阈值覆盖：dsh-app:// 属于非 HTTP origin，localStorage 可能不可用。 */
let overrideThreshold: number | undefined

export function getCurrentTokens(): number {
  return currentTokens
}

export function addTokens(tokens: number): number {
  if (Number.isFinite(tokens) && tokens > 0) currentTokens += tokens
  return currentTokens
}

export function resetTokens(): void {
  currentTokens = 0
}

export function setCurrentTokens(value: number): void {
  currentTokens = Number.isFinite(value) && value > 0 ? value : 0
}

/** 读取阈值：内存覆盖 > localStorage > 默认 80000。 */
export function getTokenThreshold(): number {
  if (overrideThreshold !== undefined) return overrideThreshold
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    const parsed = raw === null || raw === undefined ? Number.NaN : Number(raw)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  } catch {
    /* localStorage may be unavailable */
  }
  return DEFAULT_TOKEN_THRESHOLD
}

/** 写入阈值（调试用，例如 2000）。内存覆盖保证在 dsh-app:// 下也立即生效。 */
export function setTokenThreshold(value: number): number {
  const next = Math.max(1, Math.floor(Number(value)))
  overrideThreshold = next
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, String(next))
  } catch {
    /* localStorage may be unavailable */
  }
  return next
}
