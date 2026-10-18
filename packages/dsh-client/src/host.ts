/**
 * 客户端插件的宿主端（Node）半区入口
 *
 * DSH 的浏览器端插件通过 loader 条目挂载：loader 在宿主侧加载的是该包的
 * Node 半区（package.json 的 main），而真正的浏览器逻辑在
 * `dsh.client` + `exports["./client"]` 声明的浏览器 bundle 中。
 * 该 Node 半区不提供任何宿主行为，只做一个空的 Cordis 插件，
 * 让 loader 条目在宿主侧成功挂载（fiber 存活），
 * 从而被 dsh-client-modules 扫描并编入 window.__DSH_BOOT__ 图。
 *
 * @module dsh-webds-bridge-client/host
 */
export function apply() {}
