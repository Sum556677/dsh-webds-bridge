# awesome-dsh-plugin 提交 PR 模板

> 用法：找到 awesome-dsh-plugin 仓库的列表文件（通常是 `README.md`），
> 在合适分类下加入下方「列表条目」，然后提交 PR。
> PR 标题与正文可直接使用「PR 描述」部分。**请勿自动提交**，需手动操作。

---

## 一、列表条目（粘贴到 awesome 列表里）

```markdown
- [dsh-webds-bridge](https://github.com/Sum556677/dsh-webds-bridge) - 把网页版 DeepSeek 以纯 DOM 自动化接入 DSH，无需 API Key。支持多对话记忆隔离、自动续接与图形化操作面板。
```

分类建议：`Plugins` → `Integration` / `Providers` / `Browser`

---

## 二、PR 标题

```
Add dsh-webds-bridge: 网页版 DeepSeek 纯 DOM 桥接插件
```

---

## 三、PR 描述

```markdown
## 插件简介

**dsh-webds-bridge** 把网页版 DeepSeek 接入 DSH，作为「长文本讨论」这一环的补充。

DSH 主模型擅长调工具、写文件，但在超长上下文的自由讨论上不如网页版划算；
网页版擅长讨论，却没有工具能力。本插件把两者接成闭环：

    网页版纯文本讨论 → 总结归档（按别名） → API 模型带着进度调用工具执行

## 一键安装

```bash
dsh plugin --profile desktop add dsh-webds-bridge
```

安装后无需手改 `cordis.patch.yml` —— 包内自带组合包 patch，会自动挂载
Host 与 Client 两端（单包双端结构）。

## 核心特性

### 1. 纯 DOM 自动化，无需 API Key

在侧栏内置 `<webview>` 中模拟真人操作网页版，不调用任何私有接口，也不消耗 API 额度：

- 通过官方公开入口 `ctx.sidebarRight.openTab('browser', { params: { url } })` 拉起页面
- `webview.executeJavaScript` 在主世界写文本、派发事件、回车发送
- 轮询 `.ds-markdown` 读取流式回复，并从渲染后 DOM 还原代码块
- 定位「开启新对话」按钮时全页扫描 `textContent`（含 open shadow root），命中目标加 12 秒红框便于确认，并带多级兜底点击；**点击后 5 秒内必须确认页面已切换，否则报错停止，绝不盲发**

### 2. 多对话记忆隔离（防覆盖）

早期做法是固定写 `progress.md`，切换会话再保存就会互相覆盖。现在按**别名**命名：

| 别名 | 落盘位置 |
|---|---|
| `progress`（默认） | `<root>/progress.md` |
| `alpha` | `<root>/projects/alpha.md` |
| `deep/topic` | `<root>/projects/deep/topic.md` |

- 归档按别名区分，不同别名的历史互不覆盖
- 别名的上次选择记在 `config.json`，重启后自动恢复
- **别名是安全边界**：拒绝 `../`、绝对路径、盘符与非法字符，防止路径穿越

### 3. 自动续接

每轮问答后累加估算 token，达阈值自动执行：
**总结当前对话 → 归档 → 点击新建对话 → 发送续接 Prompt**，实现无缝接力。

### 4. 记忆归档与注入

- 总结经 1800 字符智能截断（优先保全「核心结论 + 已确定方案」）
- 通过 `ctx.systemPrompt.context` 动态注入，带 mtime 缓存，文件变化后自动生效
- 通过 `ctx.sessionController.prompt()` 把进度作为用户消息投递给主会话

### 5. 存储目录可迁移

- 优先级：`DSH_WEBDS_MEMORY_DIR` 环境变量 ＞ `config.json` ＞ 默认 `$DSH_HOME/dsh_memory`
- 面板提供「迁移并切换」，逐文件 **SHA-256 校验**，只复制不删除，幂等可重复执行

### 6. 图形化操作

- 设置页 `settings.section` 面板：状态、四个操作按钮、阈值配置、记忆管理与目录迁移
- 会话标题栏 `conversation.session.header.utilities`：`存记忆 | 执行 | 续接` 快捷按钮
- 全部使用官方 `--dsw-alias-*` 主题变量，深浅色自动适配

## 技术要点

- **单包双端**：一个 npm 包同时声明 `dsh.bundle` 与 `dsh.client`，一次安装激活两端
- **零运行时依赖**：React 由 DSH 的 ModuleLoader 在运行时注入，不打包
- **兼容版本**：DSH Desktop 0.2.1-rc.2+（已实测）

## 链接

- GitHub: https://github.com/Sum556677/dsh-webds-bridge
- npm: https://www.npmjs.com/package/dsh-webds-bridge
- License: MIT

## 已知限制

- 重启后需手动登录网页版（DSH 侧栏使用非持久分区，属上游设计）
- 需要 DSH Desktop 环境（依赖侧栏浏览器与桌面桥）
```

---

## 四、提交前检查

- [ ] 仓库已加 topic：`dsh-plugin`、`dsh`、`deepseek`
- [ ] npm 上 `0.1.2` 已发布
- [ ] 列表条目按字母序/分类放在正确位置
- [ ] 只改一行列表 + 一个 PR，避免与其他贡献者冲突
- [ ] 如仓库要求提供截图，附上设置页面板与会话标题栏按钮的截图
