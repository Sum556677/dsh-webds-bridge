/**
 * @deepseek-ai mock type declarations
 *
 * For local development and testing.
 * At runtime these are provided by the DSH host framework.
 */

declare module '@deepseek-ai/cordis' {
  export interface Context {
    webServer: {
      register(route: {
        kind: 'exact' | 'prefix'
        path: string
        handler: (req: any, res: any) => void
      }): void
    }
    logger: {
      info(...args: any[]): void
      warn(...args: any[]): void
      error(...args: any[]): void
    }
    inject(names: string[], callback: (scope: any) => void): void
    get(name: string, strict?: boolean): any
    effect(callback: () => (() => void) | void, label?: string): () => void
    connection: {
      fetch: {
        register(route: {
          path: string
          methods: string[]
          requestBody: 'buffered' | 'streaming'
          fetch: (request: any) => Promise<any>
        }): () => void
      }
      rpc: {
        call(
          channel: string,
          endpoint: string,
          payload: unknown,
          signal?: AbortSignal
        ): Promise<any>
      }
    }
    systemPrompt?: {
      context(contribution: {
        name: string
        order: number
        text: (context: any) => string
      }): () => void
      section(contribution: any): () => void
    }
    sessionController?: {
      prompt(request: any, signal?: AbortSignal): Promise<any>
    }
  }
}

declare module '@deepseek-ai/dsh-host-webserver' {
  // empty
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  export interface ClientContext {
    slots: any
    get(name: string, strict?: boolean): any
    /** Cordis 生命周期：回调返回 disposer，插件卸载时调用。 */
    effect(callback: () => (() => void) | void, label?: string): () => void
    connection?: {
      rpc: {
        call(
          channel: string,
          endpoint: string,
          payload: unknown,
          signal?: AbortSignal
        ): Promise<any>
      }
    }
  }
}
