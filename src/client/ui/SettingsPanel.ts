/**
 * 设置页面板：DSH 网页版桥接。
 *
 * 设计约束（与 dsh-deepseek-web-login / 官方 settings-session-log 一致）：
 *   - React 不打包，运行时从 ModuleLoader 注入：`const React = require('react')`；
 *   - 不写 JSX，避免引入 @types/react 与 tsconfig 的 jsx 配置，直接用 createElement；
 *   - 渲染函数必须返回**合法的 React 元素**，返回 undefined/对象会触发 React #130。
 *
 * 该模块只暴露一个工厂：`createSettingsPanel(deps)`，由 index.ts 注入具体行为，
 * 这样组件本身不依赖全局 window 上的调试入口（便于脱离浏览器单测）。
 */

import * as React from 'react'

const h = React.createElement

/** 面板依赖：全部由 index.ts 注入，面板不直接摸 window。 */
export interface SettingsPanelDeps {
  /** 打开（或复用）网页版 tab。 */
  openChat: () => Promise<unknown>
  /** 总结当前对话并写入 Host 的 progress.md。 */
  saveMemory: () => Promise<{ ok: boolean; message?: string } & Record<string, unknown>>
  /** 把 progress.md 作为用户消息投递到主会话。 */
  execute: () => Promise<{ ok: boolean; message?: string } & Record<string, unknown>>
  /** 强制走一遍自动续接（跳过阈值检查）。 */
  autoContinue: () => Promise<{ ok: boolean; message?: string } & Record<string, unknown>>
  /** 读当前 token 估算与阈值。 */
  tokenStatus: () => { current: number; threshold: number; ratio: number }
  /** 写 token 阈值，返回生效值。 */
  setTokenThreshold: (value: number) => number
  /** 读当前 webview 的 href / 会话 ID 等状态。 */
  webviewStatus: () => {
    href: string
    sessionId: string
    connected: boolean
    /** webview 是否真的显示在屏幕上（处在后台 tab 时为 false）。 */
    visible: boolean
    found: boolean
  }
  /** 版本号，方便确认加载的是最新 bundle。 */
  buildTag: string
  /** 存储信息（根目录、来源、当前别名、已有记忆列表）。 */
  memoryInfo: () => Promise<MemoryInfo>
  /** 设置当前记忆别名（影响后续 save / execute）。 */
  setMemoryKey: (key: string) => void
  /** 读取某个别名的内容（预览用）。 */
  readMemory: (key: string) => Promise<{ key: string; content: string; mtimeMs: number; path: string }>
  /** 设置存储根目录（不迁移文件）。 */
  setRoot: (dir: string) => Promise<{ memoryDir: string }>
  /** 迁移到新根目录（复制并校验）。 */
  migrate: (to: string, from?: string) => Promise<MigrateInfo>
}

export interface MemoryInfo {
  memoryDir: string
  rootSource: 'env' | 'config' | 'default'
  envDir: string | null
  progressPath: string
  historyPath: string
  activeKey: string
  lastKey: string | null
  memories: Array<{ key: string; path: string; bytes: number; mtimeMs: number }>
}

export interface MigrateInfo {
  ok: boolean
  from: string
  to: string
  copied: number
  skipped: number
  failed: string[]
  configWritten: boolean
  files: Array<{
    relative: string
    bytes: number
    copied: boolean
    verified: boolean
    skipped?: string
  }>
}

type BusyKey = 'open' | 'save' | 'execute' | 'auto' | 'threshold' | 'root' | 'migrate'

interface Notice {
  tone: 'ok' | 'err' | 'info'
  text: string
}

/** 判断 href 是否已进入网页版的对话页（而非登录页）。 */
function loginState(href: string): { label: string; tone: 'ok' | 'err' | 'info' } {
  if (href.length === 0) return { label: '未打开', tone: 'info' }
  if (!/chat\.deepseek\.com/u.test(href)) return { label: '已打开（非网页版）', tone: 'info' }
  if (/(?:\/sign_in|\/login|\/signup)/u.test(href)) return { label: '未登录（登录页）', tone: 'err' }
  return { label: '已登录', tone: 'ok' }
}

/** 把任意异常收敛成一行可读文案。 */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  const message = (error as any)?.message
  return typeof message === 'string' && message.length > 0 ? message : String(error)
}

/**
 * 构造设置页组件。
 * @param deps 行为注入。
 * @returns 一个无 props 的 React 函数组件。
 */
export function createSettingsPanel(deps: SettingsPanelDeps) {
  return function SettingsPanel(): React.ReactElement {
    const [busy, setBusy] = React.useState<BusyKey | null>(null)
    const [notice, setNotice] = React.useState<Notice | null>(null)
    const [status, setStatus] = React.useState(() => deps.tokenStatus())
    const [view, setView] = React.useState(() => deps.webviewStatus())
    const [thresholdDraft, setThresholdDraft] = React.useState(() =>
      String(deps.tokenStatus().threshold)
    )
    // 防连点用 ref 判断：同一帧内连点两次时 busy state 尚未提交，
    // 只有 ref 能立刻拦住第二次点击（state 依赖下一次渲染）。
    const lockedRef = React.useRef(false)

    // ── 记忆存储状态（别名 / 根目录 / 迁移） ────────────────
    const [info, setInfo] = React.useState<MemoryInfo | null>(null)
    const [aliasDraft, setAliasDraft] = React.useState('')
    const [rootDraft, setRootDraft] = React.useState('')
    const [migrateDraft, setMigrateDraft] = React.useState('')
    const [migrateState, setMigrateState] = React.useState<MigrateInfo | null>(null)
    const [preview, setPreview] = React.useState<{ key: string; chars: number; head: string } | null>(
      null
    )

    const refreshMemoryInfo = React.useCallback(async () => {
      try {
        const next = await deps.memoryInfo()
        setInfo(next)
        return next
      } catch {
        return null
      }
    }, [])

    // 面板打开时拉一次存储信息；之后随 2s 心跳低频刷新（避免频繁 RPC）。
    React.useEffect(() => {
      let disposed = false
      void refreshMemoryInfo()
      const timer = window.setInterval(() => {
        if (!disposed) void refreshMemoryInfo()
      }, 5000)
      return () => {
        disposed = true
        window.clearInterval(timer)
      }
    }, [])

    // info 到手后回填输入框（只在用户还没改过时填充）。
    React.useEffect(() => {
      if (info === null) return
      setAliasDraft((current) => (current.length > 0 ? current : info.activeKey))
      setRootDraft((current) => (current.length > 0 ? current : info.memoryDir))
      setMigrateDraft((current) => (current.length > 0 ? current : info.memoryDir))
    }, [info])

    // 面板常驻时每 2s 刷新一次状态；卸载时清掉，避免泄漏定时器。
    React.useEffect(() => {
      const tick = () => {
        try {
          setStatus(deps.tokenStatus())
          setView(deps.webviewStatus())
        } catch {
          /* 状态读取失败不影响面板存活 */
        }
      }
      tick()
      const timer = window.setInterval(tick, 2000)
      return () => window.clearInterval(timer)
    }, [])

    /**
     * 统一包装：置 busy 防连点 → 执行 → 写提示 → 解除 busy。
     * 不依赖 useCallback 缓存 availability，所有判断走 ref，避免闭包读到旧值。
     */
    const run = async (
      key: BusyKey,
      label: string,
      task: () => Promise<{ ok?: boolean; message?: string }>
    ) => {
      if (lockedRef.current) return
      lockedRef.current = true
      setBusy(key)
      setNotice({ tone: 'info', text: `${label}…` })
      try {
        const result = await task()
        const ok = result?.ok !== false
        setNotice({
          tone: ok ? 'ok' : 'err',
          text: ok ? `${label}完成` : `${label}未完成：${result?.message ?? '未知原因'}`,
        })
      } catch (error) {
        setNotice({ tone: 'err', text: `${label}失败：${errorText(error)}` })
      } finally {
        lockedRef.current = false
        setBusy(null)
        try {
          setStatus(deps.tokenStatus())
          setView(deps.webviewStatus())
        } catch {
          /* best effort */
        }
      }
    }

    const applyThreshold = () => {
      const parsed = Number(thresholdDraft)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setNotice({ tone: 'err', text: '阈值必须是大于 0 的数字' })
        return
      }
      const next = deps.setTokenThreshold(parsed)
      setThresholdDraft(String(next))
      setStatus(deps.tokenStatus())
      setNotice({ tone: 'ok', text: `阈值已设为 ${next}` })
    }

    /** 切换记忆别名。规范化由 Host 负责，这里只做非空兜底。 */
    const applyAlias = () => {
      const next = aliasDraft.trim().length > 0 ? aliasDraft.trim() : 'progress'
      try {
        deps.setMemoryKey(next)
        setAliasDraft(next)
        setNotice({ tone: 'ok', text: `记忆别名已切换为 ${next}` })
        void refreshMemoryInfo()
      } catch (error) {
        setNotice({ tone: 'err', text: `切换别名失败：${errorText(error)}` })
      }
    }

    const state = loginState(view.href)
    const ratio = Math.max(0, Math.min(1, Number.isFinite(status.ratio) ? status.ratio : 0))
    const pct = Math.round(ratio * 100)
    const disabled = busy !== null
    const button = (
      key: BusyKey,
      label: string,
      task: () => Promise<{ ok?: boolean; message?: string }>
    ) =>
      h(
        'button',
        {
          key,
          type: 'button',
          disabled,
          onClick: () => {
            void run(key, label, task)
          },
          style: buttonStyle(disabled, busy === key),
        },
        busy === key ? `${label}中…` : label
      )

    return h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 0' } },

      // ── 标题 ──────────────────────────────────────────────
      h(
        'div',
        null,
        h(
          'div',
          {
            style: {
              fontSize: '16px',
              fontWeight: 600,
              color: 'var(--dsw-alias-label-primary, #111827)',
            },
          },
          'DSH 网页版桥接'
        ),
        h(
          'div',
          { style: muted(12, 4) },
          `把网页版 DeepSeek 对话桥接到 DSH 主会话 · build=${deps.buildTag}`
        )
      ),

      // ── 状态区 ────────────────────────────────────────────
      h(
        'div',
        { style: card() },
        row('网页版状态', badge(state.label, state.tone)),
        row(
          'Href',
          h(
            'span',
            {
              style: { ...mono(), wordBreak: 'break-all', textAlign: 'right', maxWidth: '60%' },
              title: view.href,
            },
            view.href.length > 0 ? view.href : '（未打开网页版 tab）'
          )
        ),
        row(
          'Token 估算',
          h(
            'span',
            { style: mono() },
            `${Math.round(status.current)} / ${status.threshold}（${pct}%）`
          )
        ),
        h(
          'div',
          { style: barTrack() },
          h('div', { style: barFill(ratio, ratio >= 0.85) })
        ),
        row('主会话 ID', h('span', { style: mono() }, view.sessionId.length > 0 ? view.sessionId : '（未知）'))
      ),

      // ── 操作区 ────────────────────────────────────────────
      h(
        'div',
        { style: card() },
        h('div', { style: sectionTitle() }, '操作'),
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } },
          button('open', '打开网页版', async () => {
            await deps.openChat()
            return { ok: true }
          }),
          button('save', '保存记忆', () => deps.saveMemory()),
          button('execute', '执行注入', () => deps.execute()),
          button('auto', '强制自动续接', () => deps.autoContinue())
        ),
        notice === null
          ? null
          : h(
              'div',
              {
                style: {
                  marginTop: '10px',
                  fontSize: '12px',
                  lineHeight: 1.6,
                  wordBreak: 'break-word',
                  // 用主题状态色，深浅两套主题各自有对应亮度。
                  color:
                    notice.tone === 'ok'
                      ? 'var(--dsw-alias-state-success-primary, #16a34a)'
                      : notice.tone === 'err'
                        ? 'var(--dsw-alias-state-error-primary, #dc2626)'
                        : 'var(--dsw-alias-label-secondary, #6b7280)',
                },
              },
              notice.text
            )
      ),

      // ── 配置区 ────────────────────────────────────────────
      h(
        'div',
        { style: card() },
        h('div', { style: sectionTitle() }, '配置'),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '13px' } }, 'Token 阈值'),
          h('input', {
            type: 'number',
            min: 1,
            value: thresholdDraft,
            disabled,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
              setThresholdDraft(event.target.value)
            },
            onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
              if (event.key === 'Enter') applyThreshold()
            },
            style: inputStyle(),
          }),
          h(
            'button',
            {
              type: 'button',
              disabled,
              onClick: applyThreshold,
              style: buttonStyle(disabled, false),
            },
            '应用'
          )
        ),
        h(
          'div',
          { style: muted(12, 6) },
          '每轮问答结束后累加估算 token；达到阈值自动触发总结 + 新建对话 + 续接。'
        )
      ),

      // ── 记忆存储 ──────────────────────────────────────────
      h(
        'div',
        { style: card() },
        h('div', { style: sectionTitle() }, '记忆存储'),
        row(
          '存储根目录',
          h(
            'span',
            { style: { ...mono(), wordBreak: 'break-all', textAlign: 'right' }, title: info?.memoryDir },
            info === null ? '（读取中…）' : info.memoryDir
          )
        ),
        row(
          '目录来源',
          badge(
            info === null
              ? '—'
              : info.rootSource === 'env'
                ? '环境变量（只读）'
                : info.rootSource === 'config'
                  ? '面板配置'
                  : '默认',
            info?.rootSource === 'env' ? 'info' : 'ok'
          )
        ),
        info !== null && info.rootSource === 'env'
          ? h(
              'div',
              { style: muted(12, 6) },
              `已被 DSH_WEBDS_MEMORY_DIR 固定为 ${info.envDir ?? '—'}，面板修改不生效。`
            )
          : null,

        // 别名
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '10px' } },
          h('span', { style: { fontSize: '13px', flex: '0 0 auto' } }, '记忆别名'),
          h('input', {
            type: 'text',
            value: aliasDraft,
            disabled,
            placeholder: 'progress 或 projects/xxx',
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
              setAliasDraft(event.target.value)
            },
            onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
              if (event.key === 'Enter') applyAlias()
            },
            style: { ...inputStyle(), width: '200px' },
          }),
          h(
            'button',
            { type: 'button', disabled, onClick: applyAlias, style: buttonStyle(disabled, false) },
            '使用'
          ),
          info !== null && info.memories.length > 0
            ? h(
                'select',
                {
                  value: '',
                  disabled,
                  onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
                    const picked = String(event.target.value ?? '')
                    if (picked.length > 0) {
                      setAliasDraft(picked)
                      deps.setMemoryKey(picked)
                      setNotice({ tone: 'info', text: `已切换记忆别名：${picked}` })
                      void refreshMemoryInfo()
                    }
                  },
                  style: inputStyle(),
                },
                h('option', { value: '' }, `已有记忆（${info.memories.length}）`),
                ...info.memories.map((memory) =>
                  h(
                    'option',
                    { key: memory.key, value: memory.key },
                    `${memory.key}（${Math.max(1, Math.round(memory.bytes / 1024))}KB）`
                  )
                )
              )
            : null
        ),
        h(
          'div',
          { style: muted(12, 6) },
          `当前别名：${info?.activeKey ?? '—'}；保存与注入都作用于该文件。留空则用 progress。`
        ),

        // 预览
        h(
          'div',
          { style: { display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' } },
          h(
            'button',
            {
              type: 'button',
              disabled,
              onClick: () => {
                void (async () => {
                  try {
                    const key = aliasDraft.trim().length > 0 ? aliasDraft.trim() : 'progress'
                    const memory = await deps.readMemory(key)
                    setPreview({
                      key: memory.key,
                      chars: memory.content.length,
                      head: memory.content.slice(0, 240),
                    })
                    setNotice(
                      memory.content.length > 0
                        ? { tone: 'ok', text: `已读取 ${memory.key}（${memory.content.length} 字符）` }
                        : { tone: 'info', text: `${memory.key} 还不存在或为空` }
                    )
                  } catch (error) {
                    setPreview(null)
                    setNotice({ tone: 'err', text: `读取失败：${errorText(error)}` })
                  }
                })()
              },
              style: buttonStyle(disabled, false),
            },
            '预览'
          )
        ),
        preview === null
          ? null
          : h(
              'pre',
              {
                key: 'preview',
                style: {
                  marginTop: '8px',
                  maxHeight: '120px',
                  overflow: 'auto',
                  padding: '8px 10px',
                  borderRadius: 'var(--dsw-radius-sm, 8px)',
                  border: '0.5px solid var(--dsw-alias-border-l3, #e5e7eb)',
                  fontSize: '11px',
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  color: 'var(--dsw-alias-label-secondary, #6b7280)',
                },
              },
              `${preview.key} · ${preview.chars} 字符\n\n${preview.head}${preview.chars > 240 ? '\n…' : ''}`
            )
      ),

      // ── 存储根目录更换 / 迁移 ─────────────────────────────
      h(
        'div',
        { style: card() },
        h('div', { style: sectionTitle() }, '更换存储目录'),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '13px', flex: '0 0 auto' } }, '新目录'),
          h('input', {
            type: 'text',
            value: migrateDraft,
            disabled: disabled || info?.rootSource === 'env',
            placeholder: '例如 D:\\notes\\dsh_memory',
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
              setMigrateDraft(event.target.value)
              setRootDraft(event.target.value)
            },
            style: { ...inputStyle(), width: '260px' },
          })
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' } },
          h(
            'button',
            {
              type: 'button',
              disabled: disabled || info?.rootSource === 'env',
              onClick: () => {
                void run('migrate', '迁移', async () => {
                  const target = migrateDraft.trim()
                  if (target.length === 0) throw new Error('请填写新目录')
                  const result = await deps.migrate(target, info?.memoryDir)
                  setMigrateState(result)
                  await refreshMemoryInfo()
                  if (result.ok) {
                    setRootDraft(result.to)
                    setNotice({
                      tone: 'ok',
                      text: `迁移完成：复制 ${result.copied} 个、跳过 ${result.skipped} 个`,
                    })
                    return { ok: true }
                  }
                  setNotice({
                    tone: 'err',
                    text: `迁移未完成：${result.failed.slice(0, 3).join('；')}`,
                  })
                  return { ok: false, message: '部分文件校验失败' }
                })
              },
              style: buttonStyle(disabled || info?.rootSource === 'env', busy === 'migrate'),
            },
            busy === 'migrate' ? '迁移中…' : '迁移并切换'
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: disabled || info?.rootSource === 'env',
              onClick: () => {
                void run('root', '切换目录', async () => {
                  const target = migrateDraft.trim()
                  if (target.length === 0) throw new Error('请填写新目录')
                  const result = await deps.setRoot(target)
                  await refreshMemoryInfo()
                  setRootDraft(result.memoryDir)
                  return { ok: true }
                })
              },
              style: buttonStyle(disabled || info?.rootSource === 'env', busy === 'root'),
            },
            busy === 'root' ? '切换中…' : '仅切换（不迁移）'
          )
        ),
        h(
          'div',
          { style: muted(12, 6) },
          '「迁移并切换」会复制 progress.md、projects/ 与 history/ 到新目录并逐文件校验，旧文件保留不删；「仅切换」直接改指针。两者都写入 config.json，重启后仍生效。'
        ),
        migrateState === null
          ? null
          : h(
              'div',
              {
                key: 'migrate-status',
                style: {
                  marginTop: '10px',
                  fontSize: '12px',
                  lineHeight: 1.6,
                  color: migrateState.ok
                    ? 'var(--dsw-alias-state-success-primary, #16a34a)'
                    : 'var(--dsw-alias-state-error-primary, #dc2626)',
                },
              },
              [
                `${migrateState.ok ? '✔ 迁移成功' : '✖ 迁移有失败项'}  ${migrateState.from} → ${migrateState.to}`,
                `复制 ${migrateState.copied} 个 · 跳过 ${migrateState.skipped} 个 · 失败 ${migrateState.failed.length} 个`,
                migrateState.configWritten ? '已写入新目录 config.json（重启后沿用）' : '未写入配置',
                migrateState.failed.length > 0
                  ? `失败项：${migrateState.failed.slice(0, 5).join('；')}`
                  : '',
              ]
                .filter((line) => line.length > 0)
                .join('\n')
            )
      )
    )
  }
}

// ── 样式（内联，避免额外 CSS 注入与类名冲突） ──────────────────

function card(): React.CSSProperties {
  return {
    border: '0.5px solid var(--dsw-alias-border-l2, #e5e7eb)',
    borderRadius: 'var(--dsw-radius-md, 12px)',
    padding: '12px 14px',
  }
}

function sectionTitle(): React.CSSProperties {
  return {
    fontSize: '13px',
    fontWeight: 600,
    marginBottom: '10px',
    color: 'var(--dsw-alias-label-primary, #111827)',
  }
}

function muted(size = 12, marginTop = 0): React.CSSProperties {
  return {
    fontSize: `${size}px`,
    lineHeight: 1.5,
    marginTop: `${marginTop}px`,
    color: 'var(--dsw-alias-label-secondary, #6b7280)',
  }
}

function mono(): React.CSSProperties {
  return {
    fontSize: '12px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    color: 'var(--dsw-alias-label-primary, #111827)',
  }
}

function row(label: string, value: React.ReactNode): React.ReactElement {
  return h(
    'div',
    {
      key: label,
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '5px 0',
        borderBottom: '0.5px solid var(--dsw-alias-border-l3, #f1f2f4)',
      },
    },
    h(
      'span',
      {
        style: {
          fontSize: '13px',
          flex: '0 0 auto',
          color: 'var(--dsw-alias-label-primary, #111827)',
        },
      },
      label
    ),
    h('span', { style: { fontSize: '12px', textAlign: 'right' } }, value)
  )
}

function badge(label: string, tone: 'ok' | 'err' | 'info'): React.ReactElement {
  // 用主题的状态色变量：深色模式下它们会切到更亮的一档（如 green-500→green-400），
  // 再叠一个同色系的半透明底，保证两种主题下都够对比度。
  const palette =
    tone === 'ok'
      ? {
          color: 'var(--dsw-alias-state-success-primary, #16a34a)',
          border: 'var(--dsw-alias-state-success-primary, #16a34a)',
          bg: 'var(--dsw-alias-state-success-tertiary, #dcfce7)',
        }
      : tone === 'err'
        ? {
            color: 'var(--dsw-alias-state-error-primary, #dc2626)',
            border: 'var(--dsw-alias-state-error-primary, #dc2626)',
            // 主题里红色没有 tertiary 档，用官方现成的 danger 半透明底（深浅两套都有）。
            bg: 'var(--dsw-alias-interactive-bg-hover-danger, #fee2e2)',
          }
        : {
            color: 'var(--dsw-alias-label-secondary, #6b7280)',
            border: 'var(--dsw-alias-border-l4, #d1d5db)',
            bg: 'var(--dsw-alias-interactive-bg-hover, transparent)',
          }
  return h(
    'span',
    {
      style: {
        fontSize: '12px',
        lineHeight: '18px',
        padding: '0 8px',
        borderRadius: '999px',
        color: palette.color,
        background: palette.bg,
        border: `0.5px solid ${palette.border}`,
      },
    },
    label
  )
}

function barTrack(): React.CSSProperties {
  return {
    height: '4px',
    borderRadius: '2px',
    background: 'var(--dsw-alias-interactive-bg-hover, #f1f2f4)',
    overflow: 'hidden',
    margin: '6px 0 2px',
  }
}

function barFill(ratio: number, warn: boolean): React.CSSProperties {
  return {
    width: `${Math.round(ratio * 100)}%`,
    height: '100%',
    background: warn
      ? 'var(--dsw-alias-state-warn-primary, #f59e0b)'
      : 'var(--dsw-alias-brand-primary, #3b82f6)',
    transition: 'width 240ms ease',
  }
}

/**
 * 按钮配色，完全照官方 settings-models 的写法：
 *   secondary —— 无填充 + 0.5px 边框 + label-primary 文字（随主题反色）
 *   active    —— button-primary-fill 填充 + label-primary-foreground 文字（深色下是浅字压深底）
 * 关键：不要写死 background/color，也不要用 `color: inherit`——
 * 深色主题下 inherit 会继承到浅色，叠在浅底上就是白底白字。
 */
function buttonStyle(disabled: boolean, active: boolean): React.CSSProperties {
  return {
    fontSize: '13px',
    lineHeight: '28px',
    padding: '0 12px',
    fontFamily: 'inherit',
    borderRadius: 'var(--dsw-radius-sm, 8px)',
    cursor: disabled ? 'default' : 'pointer',
    // 官方用 opacity 表达禁用态；这里再压一点，避免和正常态混淆。
    opacity: disabled ? 0.5 : 1,
    border: '0.5px solid var(--dsw-alias-border-l3, #e5e7eb)',
    background: active
      ? 'var(--dsw-alias-button-primary-fill, #4176e6)'
      : 'transparent',
    color: active
      ? 'var(--dsw-alias-label-primary-foreground, #ffffff)'
      : 'var(--dsw-alias-label-primary, #111827)',
    transition: 'background-color .12s, border-color .12s, color .12s',
  }
}

function inputStyle(): React.CSSProperties {
  return {
    width: '140px',
    fontSize: '13px',
    lineHeight: '26px',
    padding: '0 8px',
    fontFamily: 'inherit',
    borderRadius: 'var(--dsw-radius-sm, 8px)',
    border: '0.5px solid var(--dsw-alias-border-l3, #e5e7eb)',
    background: 'var(--dsw-alias-bg-layer-1, transparent)',
    color: 'var(--dsw-alias-label-primary, #111827)',
    colorScheme: 'light dark',
  }
}
