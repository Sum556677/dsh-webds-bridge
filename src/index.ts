/**
 * 单包入口（Host 侧）。
 *
 * 发布形态是**一个 npm 包同时提供两端**：
 *   - `main` / `exports["."]`        → 本文件（ESM，Host 插件）
 *   - `exports["./client"]`          → 客户端 bundle（CJS，自注册到 __ModuleLoader__）
 *   - `dsh.bundle.patch`             → cordis.patch.yml 里同时插入 host + client 两条 loader
 *   - `dsh.client`                   → 声明浏览器半区（platform: web）
 *
 * 这样 `dsh plugin add dsh-webds-bridge` 一条命令即可同时激活两端，用户无需手改 patch。
 *
 * 本文件在结构上**就是**原来 packages/dsh-host/src/index.ts 的移植，
 * 逻辑逐行保持不变，只是把路径型 import 改到 ./host/*。
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'

/**
 * 用内联 import type 而不是顶层 `import type { Context }`。
 *
 * 原因：开启 declaration 后，顶层 type-only import 会被原样保留进
 * dist/index.d.ts，而 rolldown 生成 bundle 时会把它当成**值引用**去解析
 * @deepseek-ai/cordis 的具名导出（MISSING_EXPORT 报错）。
 * 内联形式只影响类型位置，不会产生任何运行期引用。
 */
import { readRoutingConfig } from './host/config'
import { migrateMemoryDir } from './host/migrate'
import {
  createMemoryStore,
  DEFAULT_MEMORY_KEY,
  normalizeMemoryKey,
  resolveMemoryRoot,
  type MemoryStore,
  type RootSource,
} from './host/memory-store'
import { installPromptInjection, type PromptInjectionHandle } from './host/prompt-inject'

/** Plugin name, follows Cordis plugin convention */
export const name = 'dsh-webds-bridge'

/** Injected dependencies */
export const inject = [] as const

const RPC_PATH = '/api/plugin-rpc/webds'
const RPC_METHOD = 'plugin-rpc/webds'
const EXECUTION_PREFIX = '以下是当前项目的最新讨论进度，请基于此开始执行：'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function failure(rpcId: string, code: string, message: string): Response {
  return jsonResponse({
    type: 'server-response',
    rpcId,
    result: { ok: false, error: { code, message, details: {} } },
  })
}

function success(rpcId: string, value: unknown): Response {
  return jsonResponse({
    type: 'server-response',
    rpcId,
    result: { ok: true, value },
  })
}

/**
 * 读取指定别名的记忆，并作为一条用户消息投递给主会话。
 * 使用 Host 的 ctx.sessionController.prompt()（Session Controller 的公开 Host 方法）。
 */
async function executePrompt(
  ctx: import('@deepseek-ai/cordis').Context,
  store: MemoryStore,
  routing: { executionModel: string },
  sessionId: string,
  key: string
): Promise<unknown> {
  const memory = await store.read(key)
  if (memory.content.trim().length === 0) {
    throw new Error(`记忆文件为空或不存在（${key}），无法执行注入`)
  }

  const sessionController =
    (ctx as any).get?.('sessionController') ?? (ctx as any).sessionController
  if (!sessionController || typeof sessionController.prompt !== 'function') {
    throw new Error('sessionController 服务不可用，无法向主会话发送消息')
  }

  const text = `${EXECUTION_PREFIX}\n\n${memory.content.trim()}`
  const requestId = randomUUID()

  const result = await sessionController.prompt(
    {
      sessionId,
      requestId,
      content: [{ type: 'text', text }],
    },
    new AbortController().signal
  )

  return {
    accepted: result?.accepted !== false,
    sessionId,
    requestId,
    key: memory.key,
    memoryPath: memory.path,
    progressChars: memory.content.length,
    textChars: text.length,
    model: routing.executionModel || null,
    memoryMtimeMs: memory.mtimeMs,
  }
}

/** Host 运行期状态：store/key 可变，供 setRoot / migrate / 面板切换后即时生效。 */
interface HostState {
  store: MemoryStore
  key: string
  routing: ReturnType<typeof readRoutingConfig>
  envDir: string | undefined
  injection: PromptInjectionHandle
}

/**
 * 写根目录指针。必须落在**默认位置**（$DSH_HOME/dsh_memory/config.json），
 * 因为启动时只会去那儿找 memoryDir；写在新根里等于自说自话，重启后会被忽略。
 */
async function writeRootPointer(targetDir: string, patch: { memoryDir: string }): Promise<void> {
  const pointer = createMemoryStore()
  await pointer.writeConfig({ ...patch, memoryDir: path.resolve(targetDir) })
}

async function handleRpc(request: Request, ctx: import('@deepseek-ai/cordis').Context, state: HostState): Promise<Response> {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })

  let body: any
  try {
    body = await request.json()
  } catch {
    return new Response('invalid JSON body', { status: 400 })
  }

  if (
    body === null ||
    typeof body !== 'object' ||
    body.type !== 'client-request' ||
    typeof body.rpcId !== 'string' ||
    typeof body.method !== 'string'
  ) {
    return new Response('invalid client-request envelope', { status: 400 })
  }
  if (body.method !== RPC_METHOD) return new Response('unknown RPC method', { status: 400 })

  const wrapped = body.payload
  if (wrapped === null || typeof wrapped !== 'object' || typeof wrapped.endpoint !== 'string') {
    return failure(body.rpcId, 'invalid-request', 'payload must be { endpoint, payload }')
  }

  const requestedKey = wrapped.payload?.key
  const key: string =
    typeof requestedKey === 'string' && requestedKey.trim().length > 0
      ? normalizeMemoryKey(requestedKey)
      : state.key

  try {
    if (wrapped.endpoint === 'save') {
      const summary = wrapped.payload?.summary
      if (typeof summary !== 'string' || summary.trim().length === 0) {
        return failure(body.rpcId, 'invalid-summary', 'summary must be a non-empty string')
      }
      const saved = await state.store.save(summary, key)
      state.key = saved.key
      state.injection.setTarget(state.store, saved.key)
      await state.store.writeConfig({ lastKey: saved.key }).catch(() => undefined)
      return success(body.rpcId, saved)
    }

    if (wrapped.endpoint === 'read') {
      return success(body.rpcId, { ...(await state.store.read(key)), routing: state.routing })
    }

    if (wrapped.endpoint === 'list') {
      return success(body.rpcId, {
        memories: await state.store.listMemories(),
        activeKey: state.key,
      })
    }

    if (wrapped.endpoint === 'info') {
      const config = await state.store.readConfig()
      return success(body.rpcId, {
        memoryDir: state.store.dir,
        rootSource: state.store.source satisfies RootSource,
        envDir: state.envDir ?? null,
        progressPath: state.store.fileFor(state.key),
        historyPath: state.store.historyPath,
        configPath: state.store.configPath,
        activeKey: state.key,
        lastKey: config.lastKey ?? null,
        memories: await state.store.listMemories(),
        routing: state.routing,
        build: 'host',
      })
    }

    if (wrapped.endpoint === 'setRoot') {
      const nextDir = wrapped.payload?.memoryDir
      if (typeof nextDir !== 'string' || nextDir.trim().length === 0) {
        return failure(body.rpcId, 'invalid-dir', 'memoryDir must be a non-empty string')
      }
      if (state.envDir) {
        return failure(
          body.rpcId,
          'env-locked',
          `已由环境变量 DSH_WEBDS_MEMORY_DIR 固定为 ${state.envDir}，面板修改不生效`
        )
      }
      const resolved = path.resolve(nextDir.trim())
      const nextStore = createMemoryStore(resolved, 'config')
      await writeRootPointer(resolved, { memoryDir: resolved })
      await nextStore.writeConfig({ memoryDir: resolved }).catch(() => undefined)
      state.store = nextStore
      state.injection.setTarget(nextStore, state.key)
      return success(body.rpcId, {
        memoryDir: nextStore.dir,
        activeKey: state.key,
        progressPath: nextStore.fileFor(state.key),
      })
    }

    if (wrapped.endpoint === 'migrate') {
      const toDir = wrapped.payload?.to
      const fromDir = wrapped.payload?.from
      if (typeof toDir !== 'string' || toDir.trim().length === 0) {
        return failure(body.rpcId, 'invalid-dir', 'to must be a non-empty string')
      }
      if (state.envDir) {
        return failure(
          body.rpcId,
          'env-locked',
          `已由环境变量 DSH_WEBDS_MEMORY_DIR 固定为 ${state.envDir}，无法迁移到其它目录`
        )
      }
      const source =
        typeof fromDir === 'string' && fromDir.trim().length > 0
          ? path.resolve(fromDir.trim())
          : state.store.dir
      const target = path.resolve(toDir.trim())
      const result = await migrateMemoryDir(source, target, true)
      if (result.ok) {
        const nextStore = createMemoryStore(target, 'config')
        // 新根必须带上当前别名：否则重启后 resolveMemoryRoot 在新根读到空 lastKey，
        // 会静默回落成 progress，用户当前的别名选择就丢了。
        await nextStore
          .writeConfig({ memoryDir: target, lastKey: state.key })
          .catch(() => undefined)
        await writeRootPointer(target, { memoryDir: target }).catch(() => undefined)
        state.store = nextStore
        state.injection.setTarget(nextStore, state.key)
      }
      return success(body.rpcId, result)
    }

    if (wrapped.endpoint === 'execute') {
      const sessionId = wrapped.payload?.sessionId
      if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
        return failure(body.rpcId, 'invalid-session', 'execute requires a non-empty sessionId')
      }
      return success(
        body.rpcId,
        await executePrompt(ctx, state.store, state.routing, sessionId.trim(), key)
      )
    }

    return failure(body.rpcId, 'unknown-endpoint', `unknown endpoint ${wrapped.endpoint}`)
  } catch (error) {
    return failure(body.rpcId, 'webds-failed', String((error as any)?.message ?? error))
  }
}

/**
 * Plugin apply function
 * @param ctx - Cordis context
 */
export function apply(ctx: import('@deepseek-ai/cordis').Context) {
  ctx.logger.info('Dsh Webds Bridge host plugin loaded')

  const initial = createMemoryStore()
  const routing = readRoutingConfig(initial.dir)
  const injection = installPromptInjection(ctx, initial, DEFAULT_MEMORY_KEY)
  const state: HostState = {
    store: initial,
    key: DEFAULT_MEMORY_KEY,
    routing,
    envDir: process.env.DSH_WEBDS_MEMORY_DIR?.trim() || undefined,
    injection,
  }

  void (async () => {
    try {
      const resolved = await resolveMemoryRoot()
      const store = createMemoryStore(resolved.dir, resolved.source)
      const config = await store.readConfig()
      const key = config.lastKey ? normalizeMemoryKey(config.lastKey) : DEFAULT_MEMORY_KEY
      state.store = store
      state.key = key
      state.envDir = resolved.envDir?.trim() || undefined
      state.injection.setTarget(store, key)
      ctx.logger.info(`[webds] memory dir = ${store.dir} (source=${resolved.source})`)
      ctx.logger.info(`[webds] active memory key = ${key}`)
      ctx.logger.info(`[webds] routing config = ${JSON.stringify(routing)}`)
    } catch (error) {
      ctx.logger.warn(`[webds] 解析记忆根目录失败，继续使用默认目录：${String(error)}`)
    }
  })()

  ctx.inject(['connection'], (scope) => {
    scope.effect(() => {
      const dispose = scope.connection.fetch.register({
        path: RPC_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request: Request) => handleRpc(request, ctx, state),
      })
      ctx.logger.info(`[webds] memory/execute RPC registered: ${RPC_PATH}`)
      return () => {
        void dispose()
      }
    }, 'webds: memory/execute RPC route')
  })
}
