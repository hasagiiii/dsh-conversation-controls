# 优化对话控件

[English](README.en.md) | 中文

本地插件 `dsh-conversation-controls`，由 `dsh-turn-delete` 0.2.5 扩展而来。

## 功能

- **删除整轮对话**：在已完成的助手回复旁点击垃圾桶并确认。该轮会从当前显示和后续模型上下文中移除，原始事件日志保留。旧插件写入的删除标记继续有效。
- **修改并重发**（0.4.0）：最近一条用户提问的右下角，复制按钮左侧有“修改”按钮。打开弹窗修改文字，点击“修改并重发”后重新生成回答，图片和文件附件保留。旧提问、回答及其后续工具记录从当前显示和模型上下文中移除；已经执行的文件修改等外部操作不会撤销。运行中按钮禁用。
- **仅保存修改**（输入框旁原有入口）：会话暂停并进入空闲状态后，可打开最新一条用户提问，修改文字后保存。附件保留，保存不自动恢复运行；继续会话时模型使用更新后的提问。
- 仅保存修改时，更新模型上下文中的该条消息。原始提问气泡、已有回答、工具记录及执行过的操作保留；重新打开编辑器可查看已保存的最新文字。若会话产生了新提问或编辑目标发生变化，旧窗口不能覆盖新内容。
- 子代理、运行中的会话、已被摘要替换而不可独立编辑的提问不会开放编辑。

## 修复

0.3.1：删除整轮后同步移除右侧快速导航条目，同时过滤已加载聊天和完整历史提纲。删除状态按整个会话日志重放，刷新、切换会话和加载旧历史后继续有效。DSH 0.2.x 尚无公开导航过滤接口，因此使用可撤销的聊天组件兼容适配；升级 DSH 后应重新验证该接口。

HTTP 请求读取改用异步迭代，兼容 WSL 路由读取并重放请求体，解决删除弹窗停留在“正在删除…”的问题。客户端请求超时会结束等待并显示提示。所有写入都经过维护锁和持久化刷新，锁不可用时不会绕过锁直接修改会话。

## 开发与安装

```sh
pnpm install
pnpm run build
pnpm test
pnpm run smoke
pnpm pack
```

使用生成的安装包，避免把源码目录里的开发版内核依赖加载进桌面进程：

```sh
dsh plugin --profile desktop add -w /absolute/path/to/dsh-conversation-controls-0.4.0.tgz
```

将 `dsh-conversation-controls` 加入 profile 的 `dsh.profile.bundles` 后重启桌面应用。若旧版仍安装，应移除 `dsh-turn-delete` 的 bundle，以免出现重复控件。

服务端接口均为 POST JSON：

- `/dsh-conversation-controls/delete`：`{sessionId, assistantMessageId}`
- `/dsh-conversation-controls/prompt`：加载 `{sessionId, action: 'load'}`；保存 `{sessionId, action: 'save', messageId, expectedSeq, text}`；重发 `{sessionId, action: 'resend', messageId, expectedSeq, text}`。重发成功返回 `submitted: true` 表示已入队并唤醒；失败提供恢复状态，结果未知时不自动重试。

提问内按钮通过可撤销的 DSH 0.2.x 用户节点适配器定位；弹窗使用会话级 factory，旧消息移除后仍可显示提交结果。旧内核保留输入框旁的保存入口。

## 来源

基于 [TiJun-Prime/dsh-turn-delete](https://github.com/TiJun-Prime/dsh-turn-delete)，保留 MIT 许可证。本版本未发布到 npm，可通过源码构建安装包。
