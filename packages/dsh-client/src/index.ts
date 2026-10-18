/**
 * Dsh Webds Bridge — Client Plugin
 *
 * DSH × 网页版 DeepSeek 对话桥接
 *
 * @module dsh-webds-bridge-client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

import {
  BUILD_TAG,
  debugWebviews,
  openChatTab,
  runDomTest,
  setTurnCompleteHandler,
  TEST_PROMPT,
} from './dom-ops'
import {
  callWebdsRpc,
  executeMemory,
  getMemoryKey,
  saveMemory,
  setMemoryKey,
} from './memory-sync'
import { forceAutoContinue, maybeAutoContinue } from './auto-continue'
import {
  getCurrentTokens,
  getTokenThreshold,
  setCurrentTokens,
  setTokenThreshold,
} from './token-estimator'
import { createSettingsPanel } from './ui/SettingsPanel'
import { createHeaderToolbar } from './ui/HeaderToolbar'

export { estimateTokens } from './token-estimator'

/** Plugin name, follows Cordis plugin convention */
export const name = 'dsh-webds-bridge-client'

/**
 * Injected dependencies。
 *
 * `slots` 用于把设置页面板注册进 `settings.section`。声明后 Cordis 会等该服务就绪再
 * 运行 apply；拿不到服务时插件不会静默半启动。
 */
export const inject = ['slots'] as const

/**
 * Plugin apply function
 * @param ctx - Client context
 */
export function apply(ctx: ClientContext) {
  console.log('[Dsh Webds Bridge] Client plugin loaded')
  console.log('[webds] build=', BUILD_TAG)

  // 探针验证开始
  const carrier = (globalThis as any).dshDesktop
  if (carrier?.protocolVersion !== 1) {
    console.warn('[webds] no desktop bridge, protocolVersion=', carrier?.protocolVersion)
  } else {
    const bridge = carrier.browser
    console.log('[webds] bridge ok, keys=', Object.keys(bridge))
    console.log('[webds] acquire type=', typeof bridge?.acquire, 'release type=', typeof bridge?.release)
  }

  // 每轮成功后累加 token；达到阈值时自动续接。
  setTurnCompleteHandler(() => maybeAutoContinue(ctx))

  const runTest = async () => {
    console.log('--- 开始 DOM 测试 ---')
    try {
      const result = await runDomTest(ctx, TEST_PROMPT)
      if (result.ok) {
        console.log('[webds] 测试成功，回复 Markdown 如下：')
        console.log(result.replyMarkdown)
        console.log('[webds] codeBlocks=', result.codeBlocks)
      } else {
        console.warn('[webds] 测试未完成：stage=', result.stage, 'message=', result.message)
        console.log('[webds] 诊断(JSON)=\n' + JSON.stringify(result, null, 2))
        console.log('[webds] 诊断(raw)=', result)
      }
      return result
    } catch (error) {
      console.error('[webds] 测试异常=', error)
      return { ok: false, stage: 'error', message: String((error as any)?.message ?? error) }
    } finally {
      console.log('--- DOM 测试结束 ---')
    }
  }

  const runSave = async () => {
    console.log('--- 开始保存记忆 ---')
    try {
      const result = await saveMemory(ctx)
      if (result.ok) {
        console.log('[webds] 保存成功:', result.host)
        console.log(
          '[webds] 字符数:',
          result.chars,
          '原始:',
          result.originalChars,
          '截断:',
          result.truncated
        )
        console.log('[webds] 已保存内容:\n' + String(result.summary ?? ''))
      } else {
        console.warn('[webds] 保存未完成：', result.stage, result.message)
        console.log('[webds] 诊断=', result)
      }
      return result
    } catch (error) {
      console.error('[webds] 保存异常=', error)
      return { ok: false, stage: 'error', message: String((error as any)?.message ?? error) }
    } finally {
      console.log('--- 保存记忆完成 ---')
    }
  }

  // 阶段 1：单独跑一轮问答
  ;(window as any).__webds_test__ = runTest

  // 阶段 2：只复用当前会话做总结保存（不会新建空 tab）
  ;(window as any).__webds_save_memory__ = runSave

  // 阶段 3：把 progress.md 作为用户消息投递到当前主会话
  ;(window as any).__webds_execute__ = async () => {
    console.log('--- 开始执行注入 ---')
    try {
      const result = await executeMemory(ctx)
      if (result.ok) {
        console.log('[webds] 执行注入成功:', result.host)
        console.log('[webds] sessionId=', result.sessionId)
      } else {
        console.warn('[webds] 执行注入未完成：', result.stage, result.message)
      }
      return result
    } catch (error) {
      console.error('[webds] 执行注入异常=', error)
      return { ok: false, stage: 'error', message: String((error as any)?.message ?? error) }
    } finally {
      console.log('--- 执行注入结束 ---')
    }
  }

  // 阶段 4：强制触发一次自动续接（跳过阈值检查）
  ;(window as any).__webds_test_auto_continue__ = async () => {
    console.log('--- 强制触发自动续接 ---')
    const threshold = getTokenThreshold()
    setCurrentTokens(Math.floor(threshold * 0.9) + 1)
    console.log('[webds] forced tokens =', Math.round(getCurrentTokens()), '/', threshold)
    try {
      const result = await forceAutoContinue(ctx)
      console.log('[webds] 自动续接结果=', JSON.stringify(result))
      return result
    } catch (error) {
      console.error('[webds] 自动续接异常=', error)
      return { ok: false, stage: 'error', message: String((error as any)?.message ?? error) }
    } finally {
      console.log('--- 自动续接结束 ---')
    }
  }

  // token 状态 / 阈值调试
  ;(window as any).__webds_token_status__ = () => {
    const status = {
      current: Math.round(getCurrentTokens()),
      threshold: getTokenThreshold(),
      ratio: getCurrentTokens() / getTokenThreshold(),
    }
    console.log('[webds] token status=', status)
    return status
  }

  ;(window as any).__webds_set_token_threshold__ = (value: number) => {
    const next = setTokenThreshold(Number(value))
    console.log('[webds] token threshold =', next)
    return next
  }

  // 记忆存储调试（阶段 8）
  ;(window as any).__webds_memory_key__ = (key?: string) => {
    if (typeof key === 'string' && key.trim().length > 0) {
      setMemoryKey(key)
      console.log('[webds] 记忆别名 ->', getMemoryKey())
    }
    console.log('[webds] 当前记忆别名 =', getMemoryKey())
    return getMemoryKey()
  }

  ;(window as any).__webds_memory_info__ = async () => {
    const info = await callWebdsRpc(ctx, 'info')
    console.log('[webds] memory info=', info)
    return info
  }

  ;(window as any).__webds_memory_list__ = async () => {
    const result = await callWebdsRpc(ctx, 'list')
    console.log('[webds] memory list=', result)
    return result
  }

  // 一键：先造真实对话，再在同一条 webview 上总结保存
  ;(window as any).__webds_test_and_save__ = async () => {
    console.log('--- 开始 测试并保存 ---')
    const tested = await runTest()
    if (!tested || tested.ok !== true) {
      console.warn('[webds] 测试未成功，跳过保存')
      return tested
    }
    return await runSave()
  }

  // 显式打开/复用，并打印当前 lease
  ;(window as any).__webds_open__ = async () => {
    try {
      await openChatTab(ctx)
      const info = debugWebviews()
      console.log('[webds] open ok:', JSON.stringify(info))
      return info
    } catch (error) {
      console.error('[webds] open 失败=', error)
      return {
        ok: false,
        message: String((error as any)?.message ?? error),
        debug: debugWebviews(),
      }
    }
  }

  // 诊断：活动引用 + DOM 里所有 webview
  ;(window as any).__webds_debug__ = () => {
    const info = debugWebviews()
    console.log('[webds] debug=', JSON.stringify(info, null, 2))
    return info
  }

  // ── 阶段 5：设置页面板 ─────────────────────────────────────
  // 面板复用上面的同一批函数，与全局调试入口行为完全一致（不是另一套实现）。
  // 设置页与工具栏（阶段 6）共享同一个 deps 对象，保证两条 UI 路径绝不发散。
  const panelDeps = {
    buildTag: BUILD_TAG,
    openChat: async () => {
      await openChatTab(ctx)
      return debugWebviews()
    },
    saveMemory: runSave,
    execute: async () => {
      // 复用阶段 3 入口，保证两条路径完全一致。
      const fn = (window as any).__webds_execute__
      return typeof fn === 'function' ? await fn() : { ok: false, message: '执行入口不可用' }
    },
    autoContinue: async () => {
      const fn = (window as any).__webds_test_auto_continue__
      return typeof fn === 'function' ? await fn() : { ok: false, message: '续接入口不可用' }
    },
    tokenStatus: () => ({
      current: getCurrentTokens(),
      threshold: getTokenThreshold(),
      ratio: getCurrentTokens() / Math.max(1, getTokenThreshold()),
    }),
    setTokenThreshold: (value: number) => setTokenThreshold(Number(value)),
    webviewStatus: () => {
      const info = debugWebviews()
      return {
        href: String(info.active?.url ?? ''),
        sessionId: String(info.sessionId ?? ''),
        connected: info.active?.connected === true,
        visible: info.active?.visible === true,
        found: info.active !== null,
      }
    },
    // ── 记忆存储（阶段 8）──────────────────────────────────
    memoryInfo: async () => await callWebdsRpc(ctx, 'info'),
    setMemoryKey: (key: string) => {
      setMemoryKey(key)
      console.log('[webds] 记忆别名已切换为', getMemoryKey())
    },
    readMemory: async (key: string) => await callWebdsRpc(ctx, 'read', { key }),
    setRoot: async (dir: string) => await callWebdsRpc(ctx, 'setRoot', { memoryDir: dir }),
    migrate: async (to: string, from?: string) =>
      await callWebdsRpc(ctx, 'migrate', from === undefined ? { to } : { to, from }),
  }

  const SettingsPanel = createSettingsPanel(panelDeps)

  // 注册进设置页：契约与官方 settings 插件一致（name/id/order/label + 组件）。
  ctx.effect(
    () =>
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'webds-bridge',
            order: 47,
            label: () => 'DSH 网页版桥接',
          },
          SettingsPanel
        )
      ),
    'webds-bridge: settings page'
  )
  console.log('[webds] settings.section 面板已注册')

  // ── 阶段 6：会话头部快捷操作栏 ──────────────────────────────
  // conversation.session.header.utilities 是官方的 list 槽位（会话标题行右侧），
  // 没有专门的「右侧栏浏览器工具条」槽位，这是最贴近且不会挤压网页版空间的落点。
  const HeaderToolbar = createHeaderToolbar(panelDeps)
  ctx.effect(() => {
    try {
      return ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register(
          {
            name: 'conversation.session.header.utilities',
            id: 'webds-bridge-toolbar',
            order: 10,
            label: () => '网页版桥接快捷操作',
          },
          HeaderToolbar
        )
      )
    } catch (error) {
      // 槽位在不同 DSH 版本可能缺失：只降级工具栏，绝不让设置页一起失效。
      console.warn('[webds] conversation.session.header.utilities 槽位不可用，快捷操作栏将不显示：', error)
      return
    }
  }, 'webds-bridge: header toolbar')
  console.log('[webds] conversation.session.header.utilities 快捷操作栏已注册')
}
