/**
 * 自动续接：token 达阈值 → 总结 → 保存 progress.md → 新建对话 → 发送续接消息。
 *
 * 新对话按钮探测顺序（从最可靠到兜底）：
 *   1. 全页（含 open shadow root）按文案找可见元素：“开启新对话 / 新建对话 / 新对话 / New chat …”
 *   2. 左上角带“加号”特征的 SVG 的父容器
 *   3. 旧的 aria/href 打分器
 * 点击后 5 秒内必须确认 URL 变化或消息清空且出现空输入框；否则报错停止，绝不发送。
 */

import { getActiveChatView, runDomTest } from './dom-ops'
import { saveSummaryToHost, SUMMARY_PROMPT, truncateSummary } from './memory-sync'
import { getCurrentTokens, getTokenThreshold, resetTokens } from './token-estimator'

export interface AutoContinueResult {
  ok: boolean
  stage: string
  message: string
  summaryChars?: number
  saved?: any
  newChat?: any
  reply?: string
  conversation?: any
  [key: string]: unknown
}

let running = false

/**
 * 在访客页执行的“新建对话”脚本。自包含，靠 .toString() 注入。
 */
function guestNewChat(): Promise<any> {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  const PHRASES = [
    '开启新对话',
    '新建对话',
    '新对话',
    'new chat',
    'new conversation',
    'start new chat',
  ]

  /** 可见且在视口内（排除 left:-198 这种折叠侧栏幽灵按钮）。 */
  const onScreen = (element: any) => {
    if (!element) return false
    try {
      if (typeof element.isConnected === 'boolean' && element.isConnected === false) return false
      if (element.closest && element.closest('[hidden], [aria-hidden="true"]') !== null) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      const opacity = style.opacity === '' ? 1 : Number(style.opacity)
      return (
        rect.width >= 8 &&
        rect.height >= 8 &&
        rect.left >= -4 &&
        rect.top >= -4 &&
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.top < window.innerHeight &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        opacity > 0
      )
    } catch {
      return false
    }
  }

  const textOf = (element: any) =>
    String(element.innerText || element.textContent || '')
      .replace(/\s+/gu, ' ')
      .trim()

  const rawTextOf = (element: any) =>
    String(element.textContent || '')
      .replace(/\s+/gu, ' ')
      .trim()

  const rectOf = (element: any) => {
    try {
      const value = element.getBoundingClientRect()
      return {
        width: Math.round(value.width),
        height: Math.round(value.height),
        left: Math.round(value.left),
        top: Math.round(value.top),
      }
    } catch {
      return null
    }
  }

  const describe = (element: any) => ({
    tag: element.tagName,
    ariaLabel: element.getAttribute?.('aria-label') || null,
    title: element.getAttribute?.('title') || null,
    testId: element.getAttribute?.('data-testid') || null,
    text: textOf(element).slice(0, 50),
    href:
      element.getAttribute?.('href') || element.closest?.('a')?.getAttribute?.('href') || null,
    className: String(element.className || '').slice(0, 100),
    hasSvg: !!element.querySelector?.('svg'),
    rect: rectOf(element),
  })

  /** 包括 open shadow root 在内的全部元素。 */
  const collectAll = () => {
    const list: any[] = []
    const walk = (root: any) => {
      let nodes: any[] = []
      try {
        nodes = Array.from(root.querySelectorAll ? root.querySelectorAll('*') : [])
      } catch {
        nodes = []
      }
      for (const node of nodes) {
        list.push(node)
        if (node.shadowRoot) walk(node.shadowRoot)
      }
    }
    walk(document)
    return list
  }

  const countMessages = () => document.querySelectorAll('.ds-markdown').length

  const findInput = () => {
    for (const selector of ['#chat-input', 'textarea', '[contenteditable="true"]']) {
      const elements = Array.from(document.querySelectorAll(selector)) as any[]
      const visible = elements.find(onScreen)
      if (visible) return visible
    }
    return undefined
  }

  const clickNative = (element: any) => {
    try {
      element.click()
      return true
    } catch {
      return false
    }
  }

  const clickMouse = (element: any) => {
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
      buttons: 1,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
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

  /** 真机上直接可见：给点击目标加 12 秒红框。 */
  const highlight = (element: any) => {
    try {
      const previousOutline = element.style.outline
      const previousOffset = element.style.outlineOffset
      element.style.outline = '2px solid red'
      element.style.outlineOffset = '2px'
      element.setAttribute('data-webds-new-chat-target', '1')
      window.setTimeout(() => {
        try {
          element.style.outline = previousOutline
          element.style.outlineOffset = previousOffset
          element.removeAttribute('data-webds-new-chat-target')
        } catch {
          /* best effort */
        }
      }, 12000)
      return true
    } catch {
      return false
    }
  }

  return (async () => {
    const beforeHref = location.href
    const beforeCount = countMessages()
    const deadline = Date.now() + 5000
    const candidates: any[] = []
    const seen = new Set<any>()
    const textMatches: any[] = []
    const svgMatches: any[] = []

    const addCandidate = (
      element: any,
      score: number,
      source: string,
      explicitTarget?: any
    ) => {
      let target = explicitTarget
      if (!target) {
        try {
          target = element.closest?.('a, button, [role="button"]') || element
        } catch {
          target = element
        }
      }
      if (!target || seen.has(target)) return
      if (!onScreen(target) && !onScreen(element)) return
      const finalTarget = onScreen(target) ? target : element
      seen.add(finalTarget)
      candidates.push({
        element,
        target: finalTarget,
        score,
        source,
        info: describe(finalTarget),
      })
    }

    // 1) 文案优先：全页扫描（含 open shadow root），按文本长度/面积挑最小命中。
    for (const element of collectAll()) {
      if (!onScreen(element)) continue
      const text = rawTextOf(element)
      if (text.length === 0 || text.length > 40) continue
      const lower = text.toLowerCase()
      if (!PHRASES.some((phrase) => lower.includes(phrase))) continue
      const rect = element.getBoundingClientRect()
      textMatches.push({
        element,
        text,
        textLength: text.length,
        area: rect.width * rect.height,
        rect: rectOf(element),
      })
    }
    textMatches.sort(
      (left, right) => left.textLength - right.textLength || left.area - right.area
    )
    for (const match of textMatches.slice(0, 12)) {
      let target = match.element
      try {
        target =
          match.element.closest?.('button, a, [role="button"], .ds-button') || match.element
      } catch {
        target = match.element
      }
      if (!onScreen(target)) target = match.element
      addCandidate(match.element, 5000, 'text', target)
    }

    // 2) SVG 加号兜底：左上角、尺寸像图标、path 里含横竖线。
    for (const svg of Array.from(document.querySelectorAll('svg')) as any[]) {
      if (!onScreen(svg)) continue
      const rect = svg.getBoundingClientRect()
      if (rect.top > 180 || rect.left > 340) continue
      if (rect.width < 10 || rect.width > 48 || rect.height < 10 || rect.height > 48) continue
      const markup = String(svg.innerHTML || '').toLowerCase()
      if (
        !/(?:m12 5v14|m5 12h14|m12 6v12|m6 12h12|m19 13h-6|m11 5h2|m12 4v16|m4 12h16)/u.test(
          markup
        )
      ) {
        continue
      }
      let target = svg.parentElement
      try {
        target =
          svg.closest?.('button, a, [role="button"], [class*="button"], [class*="btn"]') ||
          svg.parentElement
      } catch {
        target = svg.parentElement
      }
      if (!target) continue
      svgMatches.push({
        markup: markup.slice(0, 120),
        rect: rectOf(svg),
        parent: describe(target),
      })
      addCandidate(target, 1500, 'svg-plus')
    }

    // 3) 旧打分器：只保留有文案或 href="/" 的候选，避免纯 svg 幽灵图标。
    for (const element of Array.from(
      document.querySelectorAll('a, button, [role="button"], [aria-label], [data-testid]')
    ) as any[]) {
      if (!onScreen(element)) continue
      const label = [
        element.getAttribute?.('aria-label'),
        element.getAttribute?.('title'),
        element.getAttribute?.('data-testid'),
        textOf(element),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      let score = 0
      if (PHRASES.some((phrase) => label.includes(phrase))) score += 1000
      const href =
        element.getAttribute?.('href') || element.closest?.('a')?.getAttribute?.('href') || ''
      if (href === '/') score += 120
      if (score > 0) addCandidate(element, score, 'scored')
    }

    candidates.sort((left, right) => right.score - left.score)

    if (candidates.length === 0) {
      return {
        ok: false,
        stage: 'new-chat',
        message: '未找到可见的“开启新对话/新对话”按钮',
        beforeHref,
        beforeCount,
        candidates: [],
        textMatches: [],
        svgMatches: [],
      }
    }

    const best = candidates[0]
    // 点击前快照（按钮点击后可能隐藏，避免诊断里 rect 变 0）。
    const targetInfo = describe(best.target)
    const elementInfo = describe(best.element)
    const highlighted = highlight(best.target)
    const tried: any[] = []

    const attempt = async (target: any, label: string) => {
      if (Date.now() >= deadline) return
      if (!target || !onScreen(target)) return
      tried.push({ label, info: describe(target) })
      if (label.endsWith('mouse')) clickMouse(target)
      else clickNative(target)
      await sleep(1200)
    }

    const check = () => {
      const afterHref = location.href
      const afterCount = countMessages()
      const input = findInput()
      const inputFound = !!input
      const emptyInput =
        !!input && String(input.value ?? input.textContent ?? '').trim().length === 0
      const changed = afterHref !== beforeHref
      const cleared = beforeCount > 0 && afterCount === 0
      return {
        afterHref,
        afterCount,
        inputFound,
        emptyInput,
        switched: (changed || cleared) && inputFound && emptyInput,
      }
    }

    let state = check()
    if (!state.switched) {
      await attempt(best.target, 'target-native')
      state = check()
    }
    if (!state.switched) {
      await attempt(best.target, 'target-mouse')
      state = check()
    }
    if (!state.switched && best.element !== best.target) {
      await attempt(best.element, 'element-native')
      state = check()
    }
    if (!state.switched) {
      await attempt(best.target.parentElement, 'parent-native')
      state = check()
    }
    if (!state.switched) {
      await attempt(best.target.parentElement, 'parent-mouse')
      state = check()
    }

    while (!state.switched && Date.now() < deadline) {
      await sleep(120)
      state = check()
    }

    return {
      ok: state.switched,
      stage: state.switched ? 'new-chat' : 'new-chat-failed',
      message: state.switched
        ? '已创建新对话'
        : '点击后 5s 内未确认新对话（URL 未变化且消息未清空）',
      beforeHref,
      afterHref: state.afterHref,
      beforeCount,
      afterCount: state.afterCount,
      inputFound: state.inputFound,
      emptyInput: state.emptyInput,
      source: best.source,
      highlighted,
      clicked: targetInfo,
      element: elementInfo,
      tried,
      candidates: candidates.slice(0, 10).map((candidate) => ({
        score: candidate.score,
        source: candidate.source,
        info: candidate.info,
      })),
      textMatches: textMatches.slice(0, 12).map((match) => ({
        text: match.text,
        tag: match.element.tagName,
        className: String(match.element.className || '').slice(0, 80),
        rect: match.rect,
      })),
      svgMatches: svgMatches.slice(0, 6),
    }
  })()
}

/**
 * 达到阈值时执行自动续接。
 * @param ctx - Client 插件上下文。
 * @param options.force - 跳过阈值检查（测试用）。
 */
export async function maybeAutoContinue(
  ctx: any,
  options: { force?: boolean } = {}
): Promise<AutoContinueResult> {
  if (running) {
    return { ok: false, stage: 'busy', message: '自动续接已在进行中' }
  }

  const threshold = getTokenThreshold()
  const current = getCurrentTokens()
  if (options.force !== true && current < threshold * 0.85) {
    return {
      ok: false,
      stage: 'below-threshold',
      message: `token 未达阈值（${Math.round(current)} / ${threshold}）`,
    }
  }

  running = true
  try {
    console.log('[webds] 触发自动续接: tokens =', Math.round(current), '/', threshold)

    // 1) 总结
    const summaryTurn = await runDomTest(ctx, SUMMARY_PROMPT, {
      reuseOnly: true,
      suppressAutoContinue: true,
    })
    if (!summaryTurn.ok) {
      return {
        ok: false,
        stage: 'summary',
        message: summaryTurn.message ?? '总结失败',
        conversation: summaryTurn,
      }
    }

    const raw = String(summaryTurn.replyMarkdown ?? '').trim()
    if (raw.length === 0) {
      return { ok: false, stage: 'summary', message: '总结为空' }
    }
    const cut = truncateSummary(raw)

    // 2) 保存并归档到 progress.md
    let saved: any
    try {
      saved = await saveSummaryToHost(ctx, cut.text, {
        source: 'auto-continue',
        reason: options.force === true ? 'force-test' : 'token-threshold',
        originalChars: cut.originalChars,
        finalChars: cut.finalChars,
        truncated: cut.truncated,
        tokens: Math.round(current),
      })
    } catch (error) {
      return { ok: false, stage: 'save', message: String((error as any)?.message ?? error) }
    }

    // 3) 新建对话（5s 风险防御）
    const view = getActiveChatView()
    if (!view || typeof view.executeJavaScript !== 'function') {
      return { ok: false, stage: 'new-chat', message: '没有可用的 webview' }
    }
    const newChat = await view.executeJavaScript('(' + guestNewChat.toString() + ')()')
    if (!newChat || newChat.ok !== true) {
      console.warn('[webds] 新建对话失败，停止续接:', JSON.stringify(newChat))
      return {
        ok: false,
        stage: 'new-chat',
        message: newChat?.message ?? '新建对话失败',
        newChat,
      }
    }

    // 4) 发送续接消息
    const continuation =
      '这是前一轮对话的总结，请在此基础之上继续讨论：\n---\n' +
      cut.text +
      '\n---\n请确认你已理解上述上下文，然后我们继续。'
    const continued = await runDomTest(ctx, continuation, {
      reuseOnly: true,
      suppressAutoContinue: true,
    })
    if (!continued.ok) {
      return {
        ok: false,
        stage: 'continue',
        message: continued.message ?? '续接消息发送失败',
        conversation: continued,
        newChat,
      }
    }

    resetTokens()
    console.log('[webds] 续接成功，已开始新对话')
    return {
      ok: true,
      stage: 'continued',
      message: '续接成功，已开始新对话',
      summaryChars: cut.text.length,
      saved,
      newChat: {
        beforeHref: newChat.beforeHref,
        afterHref: newChat.afterHref,
        beforeCount: newChat.beforeCount,
        afterCount: newChat.afterCount,
        source: newChat.source,
        highlighted: newChat.highlighted,
        clicked: newChat.clicked,
        tried: newChat.tried,
      },
      reply: String(continued.replyMarkdown ?? '').slice(0, 300),
    }
  } finally {
    running = false
  }
}

/** 测试入口：跳过阈值检查，强制走一遍完整续接。 */
export async function forceAutoContinue(ctx: any): Promise<AutoContinueResult> {
  return await maybeAutoContinue(ctx, { force: true })
}
