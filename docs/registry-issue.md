# dsh-plugin-registry（dsplugin.app）提交 Issue 模板

> 用法：到 dsh-plugin-registry 仓库 → Issues → New Issue，选择「插件提交」类模板，
> 把下方内容按字段填入。**请勿自动提交**，需手动操作。

---

## Issue 标题

```
[Plugin] dsh-webds-bridge — 网页版 DeepSeek 纯 DOM 桥接
```

---

## Issue 正文

```markdown
## 插件信息

| 字段 | 内容 |
|---|---|
| 插件名称 | dsh-webds-bridge |
| 显示名 | DSH 网页版桥接 |
| npm 包名 | dsh-webds-bridge |
| 当前版本 | 0.1.2 |
| GitHub | https://github.com/Sum556677/dsh-webds-bridge |
| npm | https://www.npmjs.com/package/dsh-webds-bridge |
| License | MIT |
| 一键安装 | `dsh plugin --profile desktop add dsh-webds-bridge` |

## 一句话简介

把网页版 DeepSeek 以纯 DOM 自动化接入 DSH，无需 API Key；支持多对话记忆隔离、自动续接与图形化操作面板。

## 详细描述

DSH 主模型擅长调工具与写文件，但对超长上下文的自由讨论不如网页版划算；
网页版擅长讨论却没有工具能力。本插件把两者接成闭环：

    网页版纯文本讨论 → 总结归档（按别名） → API 模型带着进度调用工具执行

## 核心特性

- **纯 DOM 自动化**：在侧栏内置浏览器里模拟真人操作，不碰私有接口，不消耗 API 额度
- **多对话记忆隔离**：按别名命名记忆文件，切换会话不再互相覆盖
- **自动续接**：token 达阈值自动「总结 → 新建对话 → 接力发送」
- **记忆归档与注入**：1800 字符智能截断，mtime 缓存动态注入 system prompt
- **存储目录可迁移**：SHA-256 逐文件校验，只复制不删除，幂等
- **图形化操作**：设置页面板 + 会话标题栏快捷按钮，深浅色自适应

## 技术标签

`dsh` `dsh-plugin` `deepseek` `deepseek-harness` `cordis` `webview` `dom-automation`

## 兼容性

| 项 | 值 |
|---|---|
| DSH Desktop | 0.2.1-rc.2 及以上（已实测） |
| 平台 | Windows / macOS / Linux（桌面版） |
| 运行时依赖 | 无（React 由 DSH ModuleLoader 注入） |
| 是否含原生模块 | 否，纯 JS |

## 插件端点 / 能力

| endpoint | 作用 |
|---|---|
| `save` | 写入指定别名的记忆，旧内容归档 |
| `read` | 读取指定别名 |
| `list` | 列出全部记忆文件 |
| `info` | 返回存储根、来源、当前别名、已有记忆 |
| `setRoot` | 设置存储根目录（重启后仍生效） |
| `migrate` | 复制 + SHA-256 校验后切换根目录 |
| `execute` | 读取当前别名记忆并投递到主会话 |

## UI 挂载点

| slot | 内容 |
|---|---|
| `settings.section` | 设置面板（order 47） |
| `conversation.session.header.utilities` | 会话标题栏快捷按钮（order 10） |

## 已知限制

- 重启后需手动登录网页版：DSH 侧栏使用 `randomUUID()` 非持久分区，属上游设计
- 依赖 DSH Desktop 的侧栏浏览器与桌面桥，纯 CLI 环境不可用
- Token 为估算值（按字符长度近似），非精确计量

## 演示

<!-- TODO: 建议附 1 张设置页面板截图 + 1 张会话标题栏按钮截图 -->
- 设置页：左侧「DSH 网页版桥接」面板
- 会话标题栏：`存记忆 | 执行 | 续接`

## 提交者声明

- [x] 我是该插件的作者/维护者
- [x] 插件代码开源（MIT）
- [x] 已在真实 DSH Desktop（0.2.1-rc.2）环境测试通过
- [x] 不包含任何收集用户数据的遥测代码
```

---

## 提交前检查

- [ ] `package.json` 的 keywords 已包含全部核心词
- [ ] GitHub 仓库已加 topic（`dsh-plugin` / `dsh` / `deepseek`）
- [ ] npm 上 `0.1.2` 已发布，`npm view dsh-webds-bridge version` 返回 0.1.2
- [ ] README 顶部有一键安装命令与「无需 API Key」说明
- [ ] 准备好 1~2 张截图（设置面板 / 会话标题栏按钮）
