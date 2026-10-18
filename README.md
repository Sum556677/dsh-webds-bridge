# DSH 网页版桥接（dsh-webds-bridge）

> 把网页版 DeepSeek 的对话能力接进 DSH：侧栏拉起网页版、纯 DOM 自动化收发消息、把讨论进度按别名归档为独立记忆文件，再作为用户消息注入主会话交给本地模型执行。

[![npm](https://img.shields.io/npm/v/dsh-webds-bridge.svg)](https://www.npmjs.com/package/dsh-webds-bridge)

当前版本：`dsh-webds-bridge@0.1.1`（单包，Host + Client 一次安装）

支持的 DSH 版本：**0.2.1-rc.2 及以上**（用 0.2.1-rc.2 实测通过；0.2.0 未验证）

---

## 安装

一条命令同时装好 Host 与 Client 两端：

```bash
dsh plugin --profile <你的profile> add dsh-webds-bridge
```

> 桌面版 profile 名为 `desktop`，需在 DSH 完全退出后执行：
> ```bash
> dsh plugin --profile desktop add dsh-webds-bridge
> ```

安装后**无需手改 `cordis.patch.yml`**：本包自带组合包 patch，会自动插入 Host 与 Client 两条 loader 条目，并把包名加入 `dsh.profile.bundles`。

装完**从托盘彻底重启 DSH**（`Ctrl+Shift+R` 无效）。推送新版后升级：

```bash
dsh plugin --profile desktop add dsh-webds-bridge@latest
```

### 安装后自检

设置界面左侧应出现「**DSH 网页版桥接**」，会话标题行右侧出现 `存记忆 | 执行 | 续接` 三个按钮。
若没有，按顺序排查：

1. 是否已彻底重启 DSH；
2. `dsh plugin --profile desktop why dsh-webds-bridge` 确认已安装；
3. profile 的 `package.json` 里 `dsh.profile.bundles` 是否含 `dsh-webds-bridge`。

---

## 为什么需要它

网页版 DeepSeek 适合长文本讨论，但没有工具调用能力；DSH 主模型有工具与文件权限，却不擅长超长上下文的自由讨论。本插件把两者接成一条闭环：

```
网页版纯文本讨论  →  总结归档（按别名，如 projects/alpha.md）  →  API 模型带着进度调用工具执行
```

---

## 两条核心链路

### 链路 A：纯 DOM 自动化（Client 端）

在侧栏 `<webview>` 里模拟真人操作网页版，全程不依赖网页版私有接口：

- **拉起网页**：走官方公开入口 `ctx.sidebarRight.openTab('browser', { params: { url } })`，再从 DOM 取到 `webview[data-sidebar-browser-frame]`。
- **发消息**：`webview.executeJavaScript` 在访客页主世界写文本、派发事件、回车发送。
- **读回复**：轮询 `.ds-markdown` 正文容器，等待流式输出稳定。
- **代码块还原**：从渲染后的 DOM 还原 fenced code block（语言 + 内容）。
- **Token 估算**：每轮结束后按回复长度累加估算值，达到阈值即触发续接。
- **新建对话**：`textContent` 全页扫描（含 open shadow root）定位“开启新对话”，命中目标套 12 秒红框便于真机确认，并带 native → mouse → element → parent 多级兜底点击；**点击后 5 秒内必须确认 URL 变化或消息清空，否则报错停止，绝不盲发**。

### 链路 B：记忆与注入（Host 端）

- **写入**：总结经 1800 字符智能截断（优先保全「核心结论 + 已确定方案」），原子写入 `progress.md`，旧内容归档到 `history/`（保留最近 20 份）。
- **动态注入**：`installPromptInjection` 通过 `ctx.systemPrompt.context` 的 `text` 函数注入进度；带 **mtime + size 缓存**，`progress.md` 变化后下一次 `assemble()` 自动生效，无需重启。
- **执行注入**：`ctx.sessionController.prompt()` 把进度作为一条用户消息投递到当前主会话（RPC 端点 `execute`）。

---

## 设置页 UI 面板

在 DSH 设置界面注册 `settings.section` 槽位（`id: webds-bridge`，`order: 47`）：

| 区域 | 内容 |
|---|---|
| 状态区 | 网页版登录状态徽章、当前 Href、Token 估算与进度条、主会话 ID（每 2 秒自动刷新） |
| 操作区 | 打开网页版 / 保存记忆 / 执行注入 / 强制自动续接 |
| 配置区 | Token 阈值输入框（回车或「应用」保存） |
| 记忆存储 | 别名输入框 + 已有记忆下拉 + 预览；显示根目录与来源（默认/面板配置/环境变量） |
| 更换存储目录 | 新目录输入 + 「迁移并切换」/「仅切换」+ 迁移结果状态块 |

- **防连点**：用 `useRef` 锁而非 state 判断，同一帧内连点也能拦住；运行期间所有按钮禁用，当前按钮显示「…中」。
- **配色**：全部使用官方 `--dsw-alias-*` 主题变量，深浅色自动适配，无硬编码颜色。

此外在**会话标题行右侧**注册了 `conversation.session.header.utilities`（list 槽位），提供 `存记忆 | 执行 | 续接` 三个紧凑按钮，与设置页共用同一套 `deps`，逻辑不会发散。

---

## 多对话别名机制（防覆盖）

早期版本固定写 `progress.md`，切换网页版会话再保存就会互相覆盖。现在改为**按别名命名**：

| 别名 | 落盘位置 |
|---|---|
| `progress`（默认） | `<root>/progress.md` |
| `alpha` | `<root>/projects/alpha.md` |
| `deep/topic` | `<root>/projects/deep/topic.md` |
| `projects/a/b` | `<root>/projects/a/b.md`（已带前缀不重复拼接） |

- 归档同样按别名区分：`history/alpha-20261018-121044-631.md`，不同别名的历史互不覆盖。
- 「保存记忆」与「执行注入」始终作用于**同一个**当前别名，不会出现「存到 A、注入读 B」。
- 别名的上次选择记在 `config.json` 的 `lastKey`，重启后自动恢复。

### 别名是安全边界

别名直接参与拼接磁盘路径，因此 `normalizeMemoryKey()` 做了严格校验：

- 拒绝 `../`、`..\\`、以 `/` 或 `\\` 开头的绝对路径、`C:` 盘符、UNC 路径；
- 只允许中英文、数字、`-` `_` 与空格，单段不得以点或空格结尾；
- 最多 4 层目录、总长不超过 96 字符。

> 注意一个易错点：`/etc/passwd` 曾一度被"归一化"成 `etc/passwd` 而放行。虽然结果仍落在 root 下不致命，但语义上等于放任绝对路径，现已改为直接拒绝。

---

## 存储根目录切换与迁移

### 优先级

```
DSH_WEBDS_MEMORY_DIR 环境变量  ＞  config.json 的 memoryDir  ＞  $DSH_HOME/dsh_memory
```

环境变量优先级最高且面板只读（会明确提示"不生效"），避免用户误以为面板没保存成功。

### 指针必须写在默认位置

指针文件固定为 **`$DSH_HOME/dsh_memory/config.json`**，而不是写在当前数据目录里。

原因是启动时只会去默认位置查找 `memoryDir`；若把指针写在新目录，重启后读不到，会静默退回旧目录。这是本项目修过的一个"看似能用、重启失效"的架构缺陷。

### 迁移（`migrate` RPC）

- 复制 `progress.md`、`projects/`、`history/` 到新根；
- 逐文件比对 **size + SHA-256**，全部通过才写配置；
- **只复制不删除**，旧目录原样保留；
- 目标已有同名文件时不覆盖，记为 skipped（内容一致记为 same）；
- 幂等：重复迁移 `copied=0`；
- 风险场景直接拒绝：同目录、目标位于源内部、源不存在。

面板提供两种操作：「迁移并切换」与「仅切换（不迁移）」，并实时显示复制/跳过/失败数量。

---

## 登录态为何无法持久化（调研结论：不可行）

每次重启都要在右侧网页版手动登录，这是 DSH 的设计而非本插件的缺陷。

底层原因在桌面主进程 `main.js` 为侧栏访客分配分区的方式：

```js
partition = `dsh-sidebar-browser-${randomUUID()}`   // 注意：没有 persist: 前缀，且每次启动重新随机
```

- **非持久化分区**：没有 `persist:` 前缀，Chromium 不会把 Cookie / localStorage 落到磁盘；
- **每次进程启动重新随机**：即使偶有落盘，下次也换了分区名，读不回来。

对照组：平台账号分区用的是 `persist:dsh-platform-<sha256>`，是有意持久化的；浏览器访客分区则刻意每次重建（沙盒隔离）。

因此 [jaychang1989/dsh-webchat](https://github.com/jaychang1989/dsh-webchat) 那种"搬 localStorage / 搬 Electron Cookie"的方案在这里没有稳定容器可写入——**没有可在重启间复用的分区**。

绕过它需要修改 DSH 本体（会被升级覆盖），且会削弱其隔离设计，本项目不做。若上游将来改为持久分区，本插件无需改动即可受益。

---

## 项目结构

单包双端：一个 npm 包同时提供 Host 插件与浏览器 bundle。

```
dsh-webds-bridge/
├── src/
│   ├── index.ts               # Host 入口（main）→ dist/index.js
│   ├── client-entry.ts        # Client 入口（exports["./client"]）→ dist/client.cjs
│   ├── host/                  # Host 侧模块
│   │   ├── memory-store.ts        # 别名存储 + 归档 + 原子写入 + 根目录解析
│   │   ├── migrate.ts             # 目录迁移（复制 + SHA-256 校验）
│   │   ├── prompt-inject.ts       # systemPrompt.context 动态注入
│   │   └── config.ts              # 双模型软配置
│   └── client/                # 浏览器侧模块
│       ├── dom-ops.ts             # webview 获取、收发消息、代码块还原、BUILD_TAG
│       ├── auto-continue.ts       # 续接编排
│       ├── memory-sync.ts         # 总结 Prompt、截断、RPC 调用、当前别名
│       ├── token-estimator.ts     # token 估算
│       └── ui/                    # SettingsPanel / HeaderToolbar / react 类型垫片
├── dist/                      # 构建产物（发布内容）
│   ├── index.js                   # Host 插件（ESM）
│   └── client.cjs                 # 浏览器 bundle（CJS，自注册）
├── cordis.patch.yml           # 组合包 patch：同时插入 host + client 两条 loader
├── scripts/wrap-client-bundle.mjs
├── tsdown.config.ts
├── LICENSE
├── README.md
└── package.json
```

> `packages/` 目录是旧的 monorepo 双包结构，已**不参与构建与发布**，仅作历史参考，可安全删除。

### 关键字段

```jsonc
// package.json
{
  "name": "dsh-webds-bridge",
  "main": "./dist/index.js",            // Host 插件
  "exports": {
    ".":        { "default": "./dist/index.js" },
    "./client": { "default": "./dist/client.cjs" },  // 浏览器 bundle
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },  // 自动装配
    "client": { "platform": "web" }              // 声明浏览器半区
  },
  "files": ["dist", "cordis.patch.yml", "README.md", "LICENSE"]
}
```

```yaml
# cordis.patch.yml —— 一次插入两条，用户无需手改
- insert:
    - id: dsh-webds-bridge
      name: dsh-webds-bridge
    - id: dsh-webds-bridge-client
      name: dsh-webds-bridge
```

两条的 `name` 都是**包名**：Host 条目按 `main` 解析；Client 条目必须存在，`dsh-client-modules` 才会扫描到 `dsh.client` 并按 `exports["./client"]` 取浏览器 bundle 编入 `window.__DSH_BOOT__`。客户端 bundle 的 `__ModuleLoader__.load({ id })` 也必须等于包名。

---
## 本地开发

发布用的是单包结构，本地开发调试走软链接即可。

```bash
# 1) 构建（新版 DSH 已移除 pnpm，直接调用本地 tsdown）
cd C:\Users\MYJ\dsh-dev\dsh-webds-bridge
node node_modules\tsdown\dist\run.js
node scripts\wrap-client-bundle.mjs

# 2) 链接进 profile（先把 DSH 完全退出）
dsh plugin --profile desktop add "C:\Users\MYJ\dsh-dev\dsh-webds-bridge"

# 3) 确认 profile 的 dsh.profile.bundles 含 dsh-webds-bridge，且自动挂载两端
```

改完代码重新构建 + 托盘彻底重启即可。软链接指向源目录，`dist/` 更新后重启即生效。

> 若首次出现 `EPERM: operation not permitted, rename ... package.json`：这是 dsh 自身的问题（确认 DSH 进程已退出后直接重跑即可）。

### 打包与发布前自检

```bash
npm pack --dry-run     # 检查 tarball 内容：应只有 dist/ + cordis.patch.yml + README + LICENSE
npm publish            # 需要 npm 登录；版本号勿与已发布冲突
```

---
## 控制台调试命令

| 命令 | 作用 |
|---|---|
| `__webds_test__()` | 跑一轮问答：发消息 → 读回复 → 还原代码块 |
| `__webds_open__()` | 打开（或复用）网页版 tab |
| `__webds_save_memory__()` | 总结当前对话并写入**当前别名**的记忆文件 |
| `__webds_execute__()` | 把当前别名的记忆作为用户消息投递到主会话 |
| `__webds_test_auto_continue__()` | 强制走一遍自动续接（跳过阈值检查） |
| `__webds_token_status__()` | 查看当前 token 估算与阈值 |
| `__webds_set_token_threshold__(n)` | 设置阈值 |
| `__webds_debug__()` | 打印活动 webview 与 DOM 内所有 webview |
| `__webds_memory_key__(key?)` | 查看 / 切换当前记忆别名 |
| `__webds_memory_info__()` | 查看存储根、来源、别名、已有记忆列表 |
| `__webds_memory_list__()` | 列出全部记忆文件 |

---

## 踩坑记录（给后来者）

1. **`BUILD_TAG` 是手写字符串**，不是构建时间戳。改逻辑后务必同步 +1，否则会误判「代码没生效」。
2. **不要写 `color: inherit`**：深色主题下会继承浅色文字，叠在浅底上就是白底白字。用 `label-primary` / `label-primary-foreground` 这对随主题互反的变量。
3. **主题变量并非都存在**：审计时发现 `--dsw-alias-state-error-tertiary` 不存在（红色只有 primary/secondary）。引用变量后要核对主题文件，否则 CSS 会静默回落到 fallback。
4. **深色模式选择器是 `body[data-ds-dark-theme]`**，不是 `data-theme`。
5. **新建对话的 URL 可能不变**：新版网页版切换会话时 URL 不变，所以判定条件同时看「消息清空 + 出现空输入框」。
6. **`state-*` 之外的颜色别猜**，一律回主题文件 `dsh-client-ui-theme/lib/client.js` 核对。
7. **绝对路径不能"归一化后放行"**：`/etc/passwd` 会被削成 `etc/passwd`，看似无害实则语义错误，应直接拒绝。
8. **根目录指针要写默认位置**：写在新目录里会导致重启后读不到、静默退回旧目录。
9. **tsdown 依赖工作目录**：不在项目根运行会报 `No input files`。若用管道只取 exit code，容易把失败误判成成功——请检查产物 mtime。
10. **webview 的"可见性"只看 `[hidden]` / `aria-hidden`**：不要把"脱离 DOM / 尺寸为 0"判为失效，否则侧栏重排时会重复开 tab 并丢会话。
11. **单包双端的两个类型陷阱**：开启 `declaration` 后，顶层的 `import type { X } from '@deepseek-ai/...'` 会被保留进 `.d.ts`，rolldown 生成 bundle 时把它当成**值引用**去解析，报 `MISSING_EXPORT`。改用内联形式 `ctx: import('@deepseek-ai/cordis').Context` 即可，既不产生运行期引用也能通过类型检查。
12. **`dsh.client` 与 `dsh.bundle` 可以共存于同一个包**（参考 `dsh-deepseek-web-login`）。只要 patch 里同时插入两条 loader、且客户端 bundle 的 `__ModuleLoader__.load({ id })` 等于包名，`dsh plugin add` 就能一次激活两端。

---

## 已知限制

- `Href` 与主会话 ID 取自活动 webview 的缓存引用，网页版未打开过时显示「未打开」；点一次「打开网页版」即恢复正常。
- 网页版自身会向第三方埋点发请求，在 Network 里可能看到 5xx 噪音；这与会话数据无关，不影响本插件。
- Token 为**估算值**（按字符长度近似），非精确计量。
- **重启后必须手动登录网页版**：受限于 DSH 的非持久分区设计，见上文调研结论。网页版可能弹出"使用环境异常"风控提示，不影响 DOM 自动化链路。
- **DSH 里按 F12 打不开开发者工具**：DSH 主进程的快捷键系统对未匹配自定义键位的按键调用 `setIgnoreMenuShortcuts(true)`，而 F12 只注册为菜单加速键（`role: toggleDevTools`），因此被一并屏蔽。这是 DSH 上游行为，与本插件无关；需要看状态时直接用 `__webds_memory_info__()` 或查看磁盘上的 `config.json`。
- 迁移**不删除**旧目录，需要用户自行确认后清理，以减少误删风险。
- `history/` 统一保留最近 20 份归档，超出自动修剪。

---

## License

MIT
