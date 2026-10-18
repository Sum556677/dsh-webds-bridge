/**
 * `react` 的最小类型声明。
 *
 * 运行时由 DSH 的 ModuleLoader 提供（`factory(require)` 里的 `require('react')`），
 * 因此本仓库**不安装也不打包** react。这里只声明 UI 面板实际用到的 API，
 * 保证 tsc 能检查 JSX-free 的 createElement 调用，同时避免拉入 @types/react。
 *
 * 若将来引入 JSX，再考虑安装 @types/react 并把 jsx 配成 react-jsx。
 */
declare module 'react' {
  export type ReactNode = unknown
  export type Key = string | number

  export interface CSSProperties {
    [key: string]: string | number | undefined
  }

  /** 极简合成事件：只覆盖 onChange / onKeyDown 用到的字段。 */
  export interface ChangeEvent<T> {
    target: T & { value: string }
  }

  export interface KeyboardEvent<T> {
    key: string
    target: T
  }

  export interface ReactElement {
    readonly type: unknown
    readonly props: unknown
    readonly key: Key | null
  }

  export type FC<P = Record<string, never>> = (props: P) => ReactElement | null

  export type Dispatch<S> = (value: S) => void
  export type SetStateAction<S> = S | ((previous: S) => S)

  export type EffectCallback = () => void | (() => void)
  export type DependencyList = readonly unknown[]

  export function createElement(
    type: unknown,
    props?: (Record<string, unknown> & { key?: Key }) | null,
    ...children: ReactNode[]
  ): ReactElement

  export function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>]

  export function useEffect(effect: EffectCallback, deps?: DependencyList): void

  export function useCallback<T extends (...args: never[]) => unknown>(callback: T, deps?: DependencyList): T

  export function useMemo<T>(factory: () => T, deps?: DependencyList): T

  export function useRef<T>(initial: T): { current: T }
}
