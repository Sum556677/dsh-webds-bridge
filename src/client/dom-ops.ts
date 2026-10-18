/**
 * DSH × 网页版 DeepSeek —— 浏览器内 DOM 操作模块（最小验证版）
 *
 * 真实桥接契约（DSH 0.2.0-rc.2，已核对 app.asar）：
 *   dshDesktop.browser.acquire(workspace) -> Promise<{ lease: string, partition: string }>
 * acquire 只预租一个 guest 分区，不返回 webview。真正的 <webview> 由
 * @deepseek-ai/dsh-client-ui-sidebar-browser 创建，挂载协议为：
 *   <webview data-sidebar-browser-frame name={lease} partition={partition}
 *            src="about:blank#{lease}">
 * 主进程会在 will-attach-webview 校验 lease/partition，之后侧栏插件再导航到目标 URL。
 *
 * 因此本模块走官方公开入口 ctx.sidebarRight.openTab('browser', { params: { url } })，
 * 再从 DOM 里取到该 <webview>，用 webview.executeJavaScript 在访客页主世界执行 DOM 脚本。
 */

export const CHAT_URL = 'https://chat.deepseek.com'

export const TEST_PROMPT = '你好，请用Python写一个冒泡排序，并包含在代码块中'

/**
 * 用于确认页面加载的是最新 bundle。
 * 每次实质改动客户端逻辑时都要手动 +1，否则控制台里的版本号会误导排查。
 * v8：新对话按钮改为全页 textContent 扫描（含 open shadow root）+ 红框高亮 + 多级兜底点击。
 * v9：设置页 UI 面板（settings.section slot）。
 * v10：设置页配色改用官方 --dsw-alias-* 主题变量，修复深色模式白底白字。
 * v11：会话头部快捷操作栏 + webview 活动状态按可见性判定（修复后台 tab 抢占）。
 * v12：多对话独立记忆（别名命名）+ 自定义存储根目录 + 历史目录一键迁移。
 * v13：修复迁移后新根丢失 lastKey（重启会静默回落到 progress）。
 */
export const BUILD_TAG = '2026-10-18-stage8-v13'

import { addTokens, estimateTokens, getCurrentTokens, getTokenThreshold } from './token-estimator'

const WEBVIEW_SELECTOR = 'webview[data-sidebar-browser-frame]'

export interface CodeBlock {
  language: string
  code: string
}

export interface DomTestResult {
  ok: boolean
  stage: 'need-login' | 'send' | 'reply' | 'done' | 'error'
  message: string
  href?: string
  title?: string
  bodyText?: string
  inputSelector?: string
  replyText?: string
  replyMarkdown?: string
  codeBlocks?: CodeBlock[]
  [key: string]: unknown
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 当前页面里所有侧栏浏览器 webview。 */
function webviews(): any[] {
  return Array.from(document.querySelectorAll(WEBVIEW_SELECTOR)) as any[]
}

/** 读取 webview 的当前 URL，尚未 attach 时返回空串。 */
function safeUrl(view: any): string {
  try {
    return typeof view.getURL === 'function' ? String(view.getURL() ?? '') : ''
  } catch {
    return ''
  }
}

function leaseOf(view: any): string {
  try {
    return String(view?.getAttribute?.('name') ?? '')
  } catch {
    return ''
  }
}

function isChatUrl(url: string): boolean {
  // https://chat.deepseek.com/ 前面是 "//"；也要兼容子域（www.chat...）与纯 host。
  return /(?:^|\/\/|\.)chat\.deepseek\.com/i.test(url)
}

/**
 * 上一次成功操作过的 webview。
 * 侧栏切后台、折叠或重排时 getURL()/DOM 查询可能短暂失效，靠它兜底复用。
 */
let activeChatView: any | undefined

function rememberChatView(view: any): any {
  activeChatView = view
  return view
}

export function getActiveChatView(): any | undefined {
  return activeChatView
}

/**
 * 当前主会话 ID。优先从活动 webview 所属的右侧栏根节点读取
 * （官方 sidebar-right 用 data-sidebar-right-session 标记会话）。
 */
export function activeSessionId(view?: any): string {
  const target = view ?? activeChatView
  try {
    const owner = target?.closest?.('[data-sidebar-right-session]')
    const id = owner?.getAttribute?.('data-sidebar-right-session')
    if (typeof id === 'string' && id.length > 0) return id
  } catch {
    /* best effort */
  }

  const owners = Array.from(
    document.querySelectorAll('[data-sidebar-right-session]')
  ) as any[]
  const openOwner =
    owners.find((element) => element.hasAttribute('data-sidebar-right-open')) ?? owners[0]
  return String(openOwner?.getAttribute?.('data-sidebar-right-session') ?? '')
}

function describeView(view: any) {
  return {
    lease: leaseOf(view),
    url: safeUrl(view),
    connected: typeof view?.isConnected === 'boolean' ? view.isConnected : undefined,
    visible: isViewVisible(view),
  }
}

/**
 * webview 当前是否处在**前台 tab**。
 *
 * 背景：右侧栏用 dockkit 承载多个 tab，**非活动 tab 的 body 仍留在 DOM 里**
 * （keepMounted），只是被 `[hidden]` / `aria-hidden="true"` 隐藏。官方自己的
 * sidebarTargetFromElement 正是用这组标记判断「元素是不是活动 tab 的」。
 * 只看 getURL() 就会命中后台的旧 tab——这正是「切到网页版 tab 反而控制不了」的根因。
 *
 * 判定只用**可靠信号**：祖先上的 hidden / aria-hidden。
 * 刻意不把「尺寸为 0 / 已移出 DOM」判成不可见：
 *   - 侧栏重排时 webview 会短暂脱离文档，但 guest 仍活着，复用它是原有设计
 *     （e2e-reuse 的 scenario 1 就是这条约定）；
 *   - 折叠、dock 过渡期也会有零尺寸的瞬时状态。
 * 误判成「不可见」的代价是重复开 tab / 丢会话，比误用一次旧 tab 更贵。
 */
function isViewVisible(view: any): boolean {
  if (!view) return false
  try {
    // 隐藏的 tab：祖先带 hidden / aria-hidden（detached 元素 closest 为 null，不受影响）
    if (view.closest?.('[hidden], [aria-hidden="true"]') != null) return false
    return true
  } catch {
    return true
  }
}

/** 诊断用：当前活动引用 + DOM 里所有 webview。 */
export function debugWebviews(): {
  active: ReturnType<typeof describeView> | null
  sessionId: string
  views: ReturnType<typeof describeView>[]
} {
  return {
    active: activeChatView ? describeView(activeChatView) : null,
    sessionId: activeSessionId(),
    views: webviews().map(describeView),
  }
}

/** 是否已经打开了 chat.deepseek.com（含登录页/子路径）。 */
export function findChatWebview(): any | undefined {
  const views = webviews()

  // 1) 优先选「可见」且是 DeepSeek 页面的：这就是用户眼前那一个 tab。
  const visibleChat = views.find((view) => isChatUrl(safeUrl(view)) && isViewVisible(view))
  if (visibleChat) return rememberChatView(visibleChat)

  // 2) 没有可见的，再看 URL 命中的任意一个（隐藏 tab 才靠 getURL，避免 getURL 为空时全盘失效）。
  const anyChat = views.find((view) => isChatUrl(safeUrl(view)))
  if (anyChat) return rememberChatView(anyChat)

  // 3) getURL() 在隐藏/正在重排的 tab 上可能读不到，用上次的 lease 再兜一次。
  const lease = leaseOf(activeChatView)
  if (lease !== '') {
    const byLease = views.find((view) => leaseOf(view) === lease)
    if (byLease) return rememberChatView(byLease)
  }

  // 4) 全新打开的 tab：URL 还没 attach 上来（about:blank），但它是可见的。
  //    只认真正可见的，绝不把隐藏的陈旧 tab 当新页面。
  const visibleBlank = views.find((view) => safeUrl(view) === '' && isViewVisible(view))
  if (visibleBlank) return rememberChatView(visibleBlank)
  return undefined
}

/**
 * 优先复用缓存的 webview，但仅在它**没有退到后台 tab** 时才算数。
 *
 * 注意这里不能加 executeJavaScript 兜底：用户切到别的 tab 后旧 webview 依然
 * 能执行脚本，盲目兜底就会对着后台页面发消息——这正是「网页版 Tab 激活时
 * 反而控制不了」的根因。退到后台就交回调用方重新挑一个。
 * （侧栏重排导致短暂脱离 DOM 不算后台，那条路径由 isViewVisible 的设计保留。）
 */
async function resolveActiveView(): Promise<any | undefined> {
  const view = activeChatView
  if (!view) return undefined
  if (isViewVisible(view)) return view
  return undefined
}

export interface OpenChatOptions {
  /** true：只复用已有页面，绝不新建空 tab（save 用）。 */
  reuseOnly?: boolean
  /** 复用等待窗口（毫秒），默认 2000。 */
  reuseWaitMs?: number
}

export interface RunDomTestOptions extends OpenChatOptions {
  /** 自动续接内部调用时设为 true，避免递归触发。 */
  suppressAutoContinue?: boolean
}

export interface TurnCompleteInfo {
  prompt: string
  reply: string
  tokens: number
  result: DomTestResult
}

type TurnCompleteHandler = (info: TurnCompleteInfo) => void | Promise<unknown>

let turnCompleteHandler: TurnCompleteHandler | undefined

/** 由 auto-continue 模块注册；dom-ops 不反向依赖它，避免循环引用。 */
export function setTurnCompleteHandler(handler: TurnCompleteHandler | undefined): void {
  turnCompleteHandler = handler
}

/**
 * 打开（或复用）一个 chat.deepseek.com 的侧栏 Browser tab。
 * @param ctx - 客户端插件上下文，用来取 sidebarRight 服务。
 * @param url - 目标地址。
 * @param options - reuseOnly 时不会新建 tab。
 */
export async function openChatTab(
  ctx: any,
  url = CHAT_URL,
  options: OpenChatOptions = {}
): Promise<any> {
  const cached = await resolveActiveView()
  if (cached) {
    console.log('[webds] 复用当前活动 webview:', JSON.stringify(describeView(cached)))
    return rememberChatView(cached)
  }

  const existing = findChatWebview()
  if (existing) {
    console.log('[webds] 复用已打开的 DeepSeek 页面:', JSON.stringify(describeView(existing)))
    return existing
  }

  console.log('[webds] 未找到可复用的 webview，当前列表=', JSON.stringify(debugWebviews()))

  if (options.reuseOnly === true) {
    const deadline = Date.now() + (options.reuseWaitMs ?? 2000)
    while (Date.now() < deadline) {
      await sleep(100)
      const late = findChatWebview()
      if (late) {
        console.log('[webds] 延迟复用到 DeepSeek 页面:', JSON.stringify(describeView(late)))
        return late
      }
    }
    throw new Error(
      '没有找到已打开的 chat.deepseek.com 页面；save 不会新建空会话。请先执行 __webds_test__() 或 __webds_open__()'
    )
  }

  const previousNames = new Set(webviews().map(leaseOf))
  const sidebar = ctx?.get?.('sidebarRight') ?? ctx?.sidebarRight
  if (!sidebar || typeof sidebar.openTab !== 'function') {
    throw new Error(
      'sidebarRight 服务不可用，无法创建 Browser tab（确认 ui-sidebar-right / ui-sidebar-browser 已启用）'
    )
  }

  sidebar.openTab('browser', { params: { url } })
  console.log('[webds] 已请求打开 Browser tab:', url)

  const created = await waitForNewWebview(previousNames, 20000)
  return rememberChatView(created)
}

/**
 * 等待侧栏创建一个新的 webview（宁可超时也不误用旧 tab）。
 *
 * 选择顺序：
 *   1. lease 不在 previous 里的新 webview；
 *   2. 任何**可见**的 webview（新建的 tab 一定是可见的）；
 *   3. 已经落在 chat.deepseek.com 的 webview。
 * 第 3 条只在 1、2 都没等到时才用，避免把后台的旧 tab 当成刚开的新页。
 */
export async function waitForNewWebview(previous: Set<string>, timeoutMs = 20000): Promise<any> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const views = webviews()
    const fresh = views.find((view) => !previous.has(leaseOf(view)))
    if (fresh && isViewVisible(fresh)) return fresh
    const visible = views.find((view) => isViewVisible(view))
    if (visible) return visible
    const chat = views.find((view) => isChatUrl(safeUrl(view)))
    if (chat) return chat
    await sleep(100)
  }

  throw new Error(`等待 Browser tab 的 <webview> 超时：${JSON.stringify(debugWebviews())}`)
}

/** 等待访客页真正可执行脚本。不依赖 getURL()，直接问访客页自己的 location.href。 */
export async function waitForGuestReady(view: any, timeoutMs = 45000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  let lastHref = ''
  while (Date.now() < deadline) {
    try {
      const info = await view.executeJavaScript('({ ready: document.readyState, href: location.href })')
      const href = String((info as any)?.href ?? '')
      lastHref = href
      // 只要能执行 JS 且已经落在 chat.deepseek.com，就认为可继续；
      // 输入框/登录态由 guest 脚本自己轮询等待。
      if (isChatUrl(href)) return
    } catch (error) {
      lastError = String((error as any)?.message ?? error)
    }
    await sleep(150)
  }
  throw new Error(
    `等待 webview 就绪超时：href=${lastHref || safeUrl(view)} lastError=${lastError}`
  )
}

/**
 * 在访客页主世界执行的完整脚本（输入 → 发送 → 等回复 → 还原代码块）。
 * 注意：该函数会被 .toString() 注入 webview，必须保持自包含，不能引用模块作用域。
 * @param prompt - 要发送的问题。
 */
function guestChat(prompt: string): Promise<any> {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  const FENCE = String.fromCharCode(96, 96, 96)
  const bodyText = (limit: number) =>
    String((document.body && (document.body as any).innerText) || '')
      .replace(/\s+/gu, ' ')
      .slice(0, limit)
  const diag = () => ({ href: location.href, title: document.title, bodyText: bodyText(400) })

  const isVisible = (element: any) => {
    if (!element) return false
    try {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none'
      )
    } catch {
      return false
    }
  }

  const dumpHtml = (element: any, limit: number) => {
    try {
      return String(element?.outerHTML ?? '').slice(0, limit)
    } catch {
      return ''
    }
  }

  const rectOf = (element: any) => {
    try {
      const rect = element.getBoundingClientRect()
      return {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        left: Math.round(rect.left),
        top: Math.round(rect.top),
      }
    } catch {
      return null
    }
  }

  const describeElement = (element: any) => {
    let cursor: string | null = null
    try {
      cursor = getComputedStyle(element).cursor
    } catch {
      cursor = null
    }
    const className =
      typeof element.className === 'string'
        ? element.className
        : String(element.getAttribute?.('class') ?? '')
    return {
      tag: element.tagName,
      id: element.id || null,
      className: className.slice(0, 120),
      role: element.getAttribute?.('role') || null,
      ariaLabel: element.getAttribute?.('aria-label') || null,
      title: element.getAttribute?.('title') || null,
      testId:
        element.getAttribute?.('data-testid') || element.getAttribute?.('data-test-id') || null,
      text: String(element.textContent || '')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 60),
      disabled:
        element.disabled === true || element.getAttribute?.('aria-disabled') === 'true',
      ariaDisabled: element.getAttribute?.('aria-disabled') || null,
      visible: isVisible(element),
      hasSvg: !!element.querySelector?.('svg'),
      cursor,
      rect: rectOf(element),
      html: dumpHtml(element, 220),
    }
  }

  const findInput = (): any => {
    const selectors = [
      '#chat-input',
      'textarea[placeholder]',
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]',
    ]
    // 先找可见的，避免选中隐藏的 textarea。
    for (const selector of selectors) {
      const elements = Array.from(document.querySelectorAll(selector)) as any[]
      const visible = elements.find((element) => isVisible(element))
      if (visible) return { element: visible, selector }
    }
    for (const selector of selectors) {
      const element = document.querySelector(selector)
      if (element) return { element, selector }
    }
    return undefined
  }

  return (async () => {
    let found = findInput()
    for (let index = 0; index < 120 && !found; index += 1) {
      await sleep(100)
      found = findInput()
    }
    if (!found) {
      return {
        ok: false,
        stage: 'need-login',
        message: '12s 内未找到输入框，可能需要先手动登录 DeepSeek',
        ...diag(),
      }
    }

    const input = found.element
    const isField = input.tagName === 'TEXTAREA' || input.tagName === 'INPUT'
    const fireInput = (data: string) => {
      try {
        input.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data,
          } as any)
        )
      } catch {
        input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }))
      }
    }
    const readInput = () => String(isField ? input.value ?? '' : input.textContent ?? '')

    try {
      input.focus()
      input.click()
    } catch {
      /* best effort */
    }

    // 优先用 execCommand 模拟真实输入（能触发 React 的 beforeinput/input）。
    let execOk = false
    try {
      if (isField) {
        input.select()
      } else {
        const selection = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(input)
        selection?.removeAllRanges()
        selection?.addRange(range)
      }
      execOk = document.execCommand('insertText', false, prompt)
    } catch {
      execOk = false
    }

    // execCommand 不可用或被编辑器吞掉时，退回原生 value setter + InputEvent。
    if (!execOk || readInput() !== prompt) {
      if (isField) {
        const proto =
          input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        // React 受控组件：先清掉内部 value tracker，确保 input 事件被当作真实变更。
        try {
          const tracker = (input as any)._valueTracker
          if (tracker && typeof tracker.setValue === 'function') tracker.setValue('')
        } catch {
          /* best effort */
        }
        if (setter) setter.call(input, '')
        else input.value = ''
        fireInput('')
        if (setter) setter.call(input, prompt)
        else input.value = prompt
        fireInput(prompt)
        input.dispatchEvent(new Event('change', { bubbles: true }))
      } else {
        input.textContent = prompt
        fireInput(prompt)
      }
    }

    const valueAfterSet = readInput()

    // 真人节奏：输入后停 1-3 秒再发送。
    await sleep(1000 + Math.floor(Math.random() * 2000))

    const assistantNodes = () =>
      (Array.from(document.querySelectorAll('.ds-markdown')) as any[]).filter(
        (node) => !node.closest('ds-think-content, .ds-think-content')
      )
    const countMarkdown = () => assistantNodes().length
    const userMessageCount = () =>
      (
        Array.from(
          document.querySelectorAll(
            '[data-message-author-role="user"], .ds-user-message, [class*="user-message"]'
          )
        ) as any[]
      ).length

    const initialNodes = assistantNodes()
    const baselineText = initialNodes.length
      ? String(
          initialNodes[initialNodes.length - 1].innerText ||
            initialNodes[initialNodes.length - 1].textContent ||
            ''
        )
      : ''

    const before = countMarkdown()
    const beforeUser = userMessageCount()
    const hadText = valueAfterSet.trim().length > 0
    const inputEmpty = () => readInput().trim().length === 0

    const labelOf = (element: any) =>
      [
        element.getAttribute?.('aria-label'),
        element.getAttribute?.('title'),
        element.getAttribute?.('data-testid'),
        element.getAttribute?.('data-test-id'),
        element.textContent,
      ]
        .filter(Boolean)
        .join(' ')

    const stopVisible = () =>
      (Array.from(document.querySelectorAll('button, [role="button"]')) as any[]).some(
        (element) => isVisible(element) && /停止|stop generating|stop/iu.test(labelOf(element))
      )

    const sentNow = () =>
      countMarkdown() > before ||
      userMessageCount() > beforeUser ||
      (hadText && inputEmpty()) ||
      stopVisible()

    const fireKey = (type: string) => {
      input.dispatchEvent(
        new KeyboardEvent(type, {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
          composed: true,
          shiftKey: false,
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          isComposing: false,
        } as any)
      )
    }

    const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (predicate()) return true
        await sleep(100)
      }
      return predicate()
    }

    const scrollTo = (element: any) => {
      try {
        element.scrollIntoView({ block: 'center' })
      } catch {
        /* best effort */
      }
    }

    const clickElement = (element: any) => {
      scrollTo(element)
      try {
        element.click()
      } catch {
        /* best effort */
      }
    }

    const mouseClickElement = (element: any) => {
      scrollTo(element)
      let rect: any = { left: 0, top: 0, width: 0, height: 0 }
      try {
        rect = element.getBoundingClientRect()
      } catch {
        /* best effort */
      }
      const options = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 0,
      }
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        try {
          if (type.startsWith('pointer')) element.dispatchEvent(new PointerEvent(type, options))
          else element.dispatchEvent(new MouseEvent(type, options))
        } catch {
          /* best effort */
        }
      }
    }

    const findSendButton = () => {
      let inputRect: any = { left: 0, top: 0, bottom: 0 }
      try {
        inputRect = input.getBoundingClientRect()
      } catch {
        /* best effort */
      }
      const candidates: any[] = []
      for (const element of Array.from(
        document.querySelectorAll('button, [role="button"], [aria-label], [tabindex]')
      ) as any[]) {
        if (!isVisible(element)) continue
        if (element === input || element.contains(input)) continue
        const label = labelOf(element)
        if (/停止|stop/iu.test(label)) continue
        const isButtonish =
          element.tagName === 'BUTTON' || element.getAttribute('role') === 'button'
        if (!isButtonish && !/发送|send/iu.test(label)) continue
        const disabled =
          element.disabled === true || element.getAttribute('aria-disabled') === 'true'
        let score = 0
        if (/发送|send/iu.test(label)) score += 1000
        if (
          /上传|attach|文件|file|语音|voice|麦克风|mic|深度思考|联网|搜索|新对话|new chat/iu.test(
            label
          )
        ) {
          score -= 500
        }
        if (element.querySelector('svg')) score += 50
        if (element.closest('form')) score += 100
        try {
          const rect = element.getBoundingClientRect()
          if (inputRect.bottom > 0 && Math.abs(rect.top - inputRect.bottom) < 140) score += 80
          if (rect.left > inputRect.left) score += 20
        } catch {
          /* best effort */
        }
        if (disabled) score -= 200
        candidates.push({
          element,
          score,
          info: describeElement(element),
        })
      }

      // 兜底：一些 React 发送控件是带 <svg> 的普通 div/span，没有 role/aria-label。
      for (const svg of Array.from(document.querySelectorAll('svg')) as any[]) {
        const element = svg.parentElement
        if (!element) continue
        if (element.tagName !== 'DIV' && element.tagName !== 'SPAN') continue
        if (element.closest('button, [role="button"]')) continue
        if (!isVisible(element)) continue
        let rect: any = { width: 0, height: 0, top: 0, left: 0 }
        try {
          rect = element.getBoundingClientRect()
        } catch {
          /* best effort */
        }
        if (rect.width === 0 || rect.height === 0 || rect.width > 90 || rect.height > 90) continue
        let score = 150
        try {
          if (getComputedStyle(element).cursor === 'pointer') score += 60
          if (inputRect.bottom > 0 && Math.abs(rect.top - inputRect.bottom) < 140) score += 80
        } catch {
          /* best effort */
        }
        candidates.push({ element, score, info: describeElement(element) })
      }

      candidates.sort((left, right) => right.score - left.score)
      return candidates
    }

    // 首选 Enter（带完整修饰键），不行再按分数点发送按钮。
    fireKey('keydown')
    fireKey('keypress')
    fireKey('keyup')
    let sent = await waitFor(sentNow, 1500)

    let buttonCandidate: any
    let buttons: any[] = []
    if (!sent) {
      // 给 React 500ms 让发送按钮从 disabled 变亮。
      await sleep(500)
      buttons = findSendButton()
      buttonCandidate = buttons[0]
      if (buttonCandidate && !buttonCandidate.info.disabled) {
        clickElement(buttonCandidate.element)
        sent = await waitFor(sentNow, 1500)
        if (!sent) {
          // 只有原生 click 没生效时才补鼠标事件序列，避免重复发送。
          mouseClickElement(buttonCandidate.element)
          sent = await waitFor(sentNow, 3000)
        }
      } else {
        sent = await waitFor(sentNow, 1000)
      }
    }

    if (!sent) {
      // 最后一次：重新写入再只按 Enter。
      try {
        input.focus()
        if (isField) input.select()
        try {
          const tracker = (input as any)._valueTracker
          if (tracker && typeof tracker.setValue === 'function') tracker.setValue('')
        } catch {
          /* best effort */
        }
        document.execCommand('insertText', false, prompt)
        fireInput(prompt)
      } catch {
        /* best effort */
      }
      fireKey('keydown')
      fireKey('keyup')
      sent = await waitFor(sentNow, 2000)
    }

    if (!sent) {
      const allCandidates = (
        Array.from(
          document.querySelectorAll('button, [role="button"], [aria-label], [tabindex]')
        ) as any[]
      )
        .slice(0, 40)
        .map(describeElement)
      const svgClickables = (Array.from(document.querySelectorAll('svg')) as any[])
        .map((svg) => svg.parentElement)
        .filter(
          (element) =>
            element && (element.tagName === 'DIV' || element.tagName === 'SPAN')
        )
        .slice(0, 20)
        .map(describeElement)
      const container =
        input.closest('form') || input.parentElement?.parentElement || input.parentElement

      return {
        ok: false,
        stage: 'send',
        message: '未能确认消息已发送（Enter 与发送按钮都没有产生新回复）',
        ...diag(),
        inputSelector: found.selector,
        inputTag: input.tagName,
        inputId: input.id || null,
        inputClass:
          typeof input.className === 'string' ? input.className.slice(0, 120) : '',
        inputHtml: dumpHtml(input, 300),
        inputValueLength: valueAfterSet.length,
        inputValuePreview: valueAfterSet.slice(0, 120),
        inputValueNow: readInput().slice(0, 120),
        inputDisabled: input.disabled === true,
        inputReadOnly: input.readOnly === true,
        execCommandOk: execOk,
        activeElement: document.activeElement
          ? describeElement(document.activeElement)
          : null,
        buttons: buttons.slice(0, 10).map((candidate) => candidate.info),
        allCandidates,
        svgClickables,
        containerTag: container?.tagName ?? null,
        containerHtml: dumpHtml(container, 1500),
        bestButtonScore: buttonCandidate?.score ?? null,
        stopVisible: stopVisible(),
        markdownDelta: countMarkdown() - before,
        userMessageDelta: userMessageCount() - beforeUser,
        hadText,
      }
    }

    let observer: MutationObserver | undefined
    let idleTimer: any = null
    let hardTimer: any = null
    let lastText = ''

    const done = new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        if (observer) observer.disconnect()
        clearTimeout(idleTimer)
        clearTimeout(hardTimer)
        resolve()
      }
      const consider = () => {
        const nodes = assistantNodes()
        const node = nodes[nodes.length - 1]
        const text = node ? String(node.innerText || node.textContent || '') : ''
        // 新节点刚插入但还没有正文时，继续等第一段流式内容。
        if (!text) return
        const isNew = nodes.length > before
        if (!isNew && text === baselineText) return
        if (text === lastText) return
        lastText = text
        clearTimeout(idleTimer)
        idleTimer = setTimeout(finish, 300)
      }
      observer = new MutationObserver(consider)
      observer.observe(document.body as any, {
        childList: true,
        subtree: true,
        characterData: true,
      })
      hardTimer = setTimeout(finish, 120000)
      // 回复可能在观察器安装前就已开始甚至结束，先主动检查一次。
      setTimeout(consider, 0)
    })
    await done

    const nodes = assistantNodes()
    const node = nodes[nodes.length - 1]
    if (!node) {
      return {
        ok: false,
        stage: 'reply',
        message: '等待回复超时，未找到正文容器 .ds-markdown',
        ...diag(),
      }
    }

    const clone = node.cloneNode(true) as any
    for (const thinking of Array.from(
      clone.querySelectorAll('ds-think-content, .ds-think-content')
    ) as any[]) {
      thinking.remove()
    }

    const codeBlocks: CodeBlock[] = []
    for (const pre of Array.from(clone.querySelectorAll('pre')) as any[]) {
      const codeElement = pre.querySelector('code') || pre
      const raw = String(codeElement.innerText || codeElement.textContent || '')
      const code = raw.replace(/\n+$/u, '')
      const classes =
        String((codeElement.getAttribute && codeElement.getAttribute('class')) || '') +
        ' ' +
        String((pre.getAttribute && pre.getAttribute('class')) || '')
      let language = ''
      const match = classes.match(/(?:language|lang)-([A-Za-z0-9_+#.-]+)/u)
      if (match) language = match[1]
      else {
        const dataLang =
          (codeElement.getAttribute &&
            (codeElement.getAttribute('data-lang') || codeElement.getAttribute('data-language'))) ||
          (pre.getAttribute && pre.getAttribute('data-lang'))
        if (dataLang) language = String(dataLang)
      }
      codeBlocks.push({ language, code })
      const replacement = document.createTextNode(
        '\n' + FENCE + language + '\n' + code + '\n' + FENCE + '\n'
      )
      if (pre.parentNode) pre.parentNode.replaceChild(replacement, pre)
    }

    // 临时挂到 body 上，让 innerText 产生正确的块级换行，再取 Markdown 文本。
    clone.style.position = 'fixed'
    clone.style.left = '-99999px'
    clone.style.top = '0'
    clone.style.whiteSpace = 'pre-wrap'
    document.body.appendChild(clone)
    const replyMarkdown = String(clone.innerText || clone.textContent || '').trim()
    clone.remove()

    return {
      ok: true,
      stage: 'done',
      message: '回复完成，代码块已还原为 Markdown 围栏',
      ...diag(),
      inputSelector: found.selector,
      replyText: replyMarkdown,
      replyMarkdown,
      codeBlocks,
    }
  })()
}

/** 执行一次完整测试：打开/复用 tab → 等就绪 → 注入脚本 → 返回结构化结果。 */
export async function runDomTest(
  ctx: any,
  prompt = TEST_PROMPT,
  options: RunDomTestOptions = {}
): Promise<DomTestResult> {
  const view = await openChatTab(ctx, CHAT_URL, options)
  console.log('[webds] 使用 webview:', JSON.stringify(describeView(view)))

  if (typeof view.executeJavaScript !== 'function') {
    throw new Error(
      '该 <webview> 没有 executeJavaScript（keys=' +
        Object.keys(view).slice(0, 20).join(',') +
        '）'
    )
  }

  await waitForGuestReady(view)
  console.log('[webds] guest ready, lease=', leaseOf(view), '—— 开始注入 DOM 脚本')

  const script = '(' + guestChat.toString() + ')(' + JSON.stringify(prompt) + ')'
  const result = (await view.executeJavaScript(script)) as DomTestResult

  if (result) (result as any).build = BUILD_TAG

  if (result && result.stage === 'send') {
    // 单行 JSON，避免控制台把对象折叠或把大字段吞掉。
    console.log('[webds][SEND_DIAG] ' + JSON.stringify(result))
  }

  if (result && result.stage === 'need-login') {
    console.warn(
      '[webds] 需要先登录：请在右侧 Browser tab 里完成 DeepSeek 登录，然后重新执行 __webds_test__()'
    )
  }

  // 每轮成功回复后累加 token；达到阈值时交给 auto-continue 处理器。
  if (result && result.stage === 'done' && options.suppressAutoContinue !== true) {
    const turnTokens =
      estimateTokens(prompt) + estimateTokens(String(result.replyMarkdown ?? ''))
    addTokens(turnTokens)
    ;(result as any).tokens = {
      turn: turnTokens,
      total: getCurrentTokens(),
      threshold: getTokenThreshold(),
    }
    console.log(
      '[webds] tokens +=',
      turnTokens,
      '| total =',
      Math.round(getCurrentTokens()),
      '/',
      getTokenThreshold()
    )

    if (turnCompleteHandler !== undefined) {
      try {
        await turnCompleteHandler({
          prompt,
          reply: String(result.replyMarkdown ?? ''),
          tokens: turnTokens,
          result,
        })
      } catch (error) {
        console.warn('[webds] turn-complete handler failed:', error)
      }
    }
  }

  return result
}
