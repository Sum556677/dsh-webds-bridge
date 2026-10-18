/**
 * 双模型路由的软配置（阶段 3 只读取，不改变实际模型路由）。
 *
 * 读取优先级：
 *   1. $DSH_WEBDS_MEMORY_MODEL / $DSH_WEBDS_EXECUTION_MODEL
 *   2. <memoryDir>/config.json 里的 memoryInjectionModel / executionModel
 *   3. 空字符串（跟随当前会话默认模型）
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export interface RoutingConfig {
  memoryInjectionModel: string
  executionModel: string
  source: string
}

export function readRoutingConfig(memoryDir: string): RoutingConfig {
  const envMemory = process.env.DSH_WEBDS_MEMORY_MODEL ?? ''
  const envExecution = process.env.DSH_WEBDS_EXECUTION_MODEL ?? ''
  const file = path.join(memoryDir, 'config.json')

  if (existsSync(file)) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      return {
        memoryInjectionModel: String(data.memoryInjectionModel ?? envMemory),
        executionModel: String(data.executionModel ?? envExecution),
        source: file,
      }
    } catch {
      /* fall through to env/default */
    }
  }

  return {
    memoryInjectionModel: envMemory,
    executionModel: envExecution,
    source: 'env/default',
  }
}
