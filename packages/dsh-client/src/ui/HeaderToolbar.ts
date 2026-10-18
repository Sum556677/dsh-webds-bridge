/**
 * 会话头部快捷操作栏（阶段 6）。
 *
 * 挂载点：`conversation.session.header.utilities`（官方 list 槽位）。
 *
 * 为什么不是「侧栏浏览器上方」：调研官方 ui-sidebar-right / ui-sidebar-browser 后确认，
 * 右侧栏没有 header/toolbar 槽位。它唯一的两个槽位是：
 *   - sidebar.right.pane.tab       （keyed：按 tab kind 分派 tab 正文）
 *   - sidebar.right.pane.tab.title （keyed：按 tab kind 渲染该 tab 的标题 chip）
 * 两者都是「每个 tab 一份」的 keyed 座位，注册进来会**顶替浏览器 tab 自己的标题/正文**，
 * 而不是并排加一个按钮。所以选了会话标题行右侧的 list 槽位：
 * 位置显眼、可并排多个、且完全不占用网页版的高度。
 *
 * 逻辑与设置页完全一致：两者接收同一个 deps 对象（见 index.ts 的 panelDeps）。
 */

import * as React from 'react'

import type { SettingsPanelDeps } from './SettingsPanel'

const h = React.createElement

type BusyKey = 'save' | 'execute' | 'auto'

/** 三个高频操作的紧凑定义。 */
const ACTIONS: Array<{
  key: BusyKey
  short: string
  tip: string
  run: (deps: SettingsPanelDeps) => Promise<{ ok?: boolean; message?: string }>
}> = [
  {
    key: 'save',
    short: '存记忆',
    tip: '保存记忆：总结当前网页版对话并写入 progress.md',
    run: (deps) => deps.saveMemory(),
  },
  {
    key: 'execute',
    short: '执行',
    tip: '执行注入：把 progress.md 作为用户消息投递到当前主会话',
    run: (deps) => deps.execute(),
  },
  {
    key: 'auto',
    short: '续接',
    tip: '强制自动续接：总结 → 新建对话 → 发送续接 Prompt（跳过阈值检查）',
    run: (deps) => deps.autoContinue(),
  },
]

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  const message = (error as any)?.message
  return typeof message === 'string' && message.length > 0 ? message : String(error)
}

/**
 * 构造工具栏组件。
 * @param deps 与设置页共用的行为注入。
 * @returns 无 props 的 React 函数组件。
 */
export function createHeaderToolbar(deps: SettingsPanelDeps) {
  return function WebdsHeaderToolbar(): React.ReactElement {
    const [busy, setBusy] = React.useState<BusyKey | null>(null)
    const [notice, setNotice] = React.useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
    // 同设置页：防连点用 ref，避免 state 尚未提交时被快速二次点击穿透。
    const lockedRef = React.useRef(false)

    const run = async (action: (typeof ACTIONS)[number]) => {
      if (lockedRef.current) return
      lockedRef.current = true
      setBusy(action.key)
      setNotice(null)
      try {
        const result = await action.run(deps)
        const ok = result?.ok !== false
        setNotice(
          ok
            ? { tone: 'ok', text: `${action.short}完成` }
            : { tone: 'err', text: `${action.short}失败：${result?.message ?? '未知原因'}` }
        )
      } catch (error) {
        setNotice({ tone: 'err', text: `${action.short}失败：${errorText(error)}` })
      } finally {
        lockedRef.current = false
        setBusy(null)
      }
    }

    const disabled = busy !== null

    return h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          // 不占额外高度：与会话标题行同高，靠右紧凑排列。
          flex: 'none',
        },
        // 便于真机排查定位
        'data-webds-toolbar': '1',
      },
      ...ACTIONS.map((action) =>
        h(
          'button',
          {
            key: action.key,
            type: 'button',
            title: action.tip,
            'aria-label': action.tip,
            disabled,
            onClick: () => {
              void run(action)
            },
            style: {
              fontSize: '12px',
              lineHeight: '22px',
              padding: '0 8px',
              fontFamily: 'inherit',
              whiteSpace: 'nowrap',
              borderRadius: 'var(--dsw-radius-sm, 8px)',
              border: '0.5px solid var(--dsw-alias-border-l3, #e5e7eb)',
              // 与设置页同一套主题变量：深色下浅字深底，浅色下深字浅底。
              background: busy === action.key
                ? 'var(--dsw-alias-button-primary-fill, #4176e6)'
                : 'transparent',
              color: busy === action.key
                ? 'var(--dsw-alias-label-primary-foreground, #ffffff)'
                : 'var(--dsw-alias-label-primary, #111827)',
              cursor: disabled ? 'default' : 'pointer',
              opacity: disabled && busy !== action.key ? 0.5 : 1,
              transition: 'background-color .12s, color .12s, opacity .12s',
            },
          },
          busy === action.key ? `${action.short}…` : action.short
        )
      ),
      notice === null
        ? null
        : h(
            'span',
            {
              key: 'notice',
              title: notice.text,
              style: {
                fontSize: '11px',
                lineHeight: '20px',
                maxWidth: '180px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                marginLeft: '2px',
                color:
                  notice.tone === 'ok'
                    ? 'var(--dsw-alias-state-success-primary, #16a34a)'
                    : 'var(--dsw-alias-state-error-primary, #dc2626)',
              },
            },
            notice.text
          )
    )
  }
}
