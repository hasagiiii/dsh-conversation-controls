# 优化对话控件

[English](README.en.md) | 中文

本地插件 `dsh-conversation-controls`，由 `dsh-turn-delete` 0.2.5 扩展而来。

## 功能

- **删除整轮对话**：在已完成的助手回复旁点击垃圾桶并确认。该轮会从当前显示和后续模型上下文中移除，原始事件日志保留。旧插件写入的删除标记继续有效。
- **修改并重发**（0.4.0）：最近一条用户提问的右下角，复制按钮左侧有“修改”按钮。点击后该条消息直接变成文字输入框（0.4.1），修改后点“发送”（或 Ctrl/⌘+Enter）重新生成回答，点“取消”（或 Esc）恢复原消息；图片和文件附件保留。旧提问、回答及其后续工具记录从当前显示和模型上下文中移除；已经执行的文件修改等外部操作不会撤销。运行中按钮禁用。
- 编辑入口仅保留最近一条提问旁的“修改”按钮；输入框下方不再显示“修改上次提问”。
- 子代理、运行中的会话、已被摘要替换而不可独立编辑的提问不会开放编辑。

## 修复

0.4.4：修复正常系统提示清理被误认成整轮删除，导致最新问答消失、仅剩任务，并使“修改”错误地指向上一条提问的问题。前后端统一只识别带插件身份的删除标记，升级后自动重建删除状态缓存，无需修改会话日志。没有插件身份的旧 v4 空系统替换不再被当成整轮隐藏依据；原有消息替换效果仍保留。

0.4.3：修复删除或修改重发后，重启时报 `system/message does not match an open turn and step` 的历史加载错误。v4 删除标记现在写入完整的独立维护轮次，并同步 DSH 0.2.1 维护锁中的轮次计数，保证继续对话不会复用轮次号。原始目标轮次单独保存，维护轮次不会进入导航或增加模型消息。适配器无法确认宿主计数结构时拒绝写入；升级宿主后需要重新验证。新增当前宿主严格持久化恢复、失败重试和继续对话回归；已有损坏日志须另行备份恢复，升级插件本身不会重写历史。

0.4.2：修复修改并重发后仍显示旧回答的问题。依据完整会话的删除状态，按宿主的轮次标记隐藏旧提问、分组回答、工具记录及自动续接轮次，不依赖尾行重新渲染。新回答接在修改后的提问下面；刷新和加载历史后仍保持，多个会话的显示相互隔离。此显示适配已按 DSH 0.2.1 的节点与分组属性验证，升级宿主后应重新检查兼容性。

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

当前宿主回归另外运行 `DSH_V4_ROOT=/path/to/extracted/dsh node scripts/check-v4.mjs`（需要包含 `dsh-agent-loop`、会话格式 catalog 及其运行依赖的已解压 v4 宿主；默认使用本地 `.scratch/v4-host/dsh`）。它使用宿主官方严格恢复器和真实维护/驱动方法，验证删除、重发、失败恢复、重新加载及下一轮计数；不会调用模型服务。

本地 Git 安装需要先构建并提交 `lib`，再安装该仓库的分支；后续更新使用 `update --force` 解析新的提交。这样可以避免把源码目录里的开发版内核依赖加载进桌面进程：

```sh
dsh plugin --profile desktop add -w git+file:///absolute/path/to/dsh-conversation-controls#main
dsh plugin --profile desktop update dsh-conversation-controls --force
```

也可以安装 `pnpm pack` 生成的 `dsh-conversation-controls-0.4.4.tgz`。

将 `dsh-conversation-controls` 加入 profile 的 `dsh.profile.bundles` 后重启桌面应用。若旧版仍安装，应移除 `dsh-turn-delete` 的 bundle，以免出现重复控件。

服务端接口均为 POST JSON：

- `/dsh-conversation-controls/delete`：`{sessionId, assistantMessageId}`
- `/dsh-conversation-controls/prompt`：加载 `{sessionId, action: 'load'}`；保存 `{sessionId, action: 'save', messageId, expectedSeq, text}`；重发 `{sessionId, action: 'resend', messageId, expectedSeq, text}`。重发成功返回 `submitted: true` 表示已入队并唤醒；失败提供恢复状态，结果未知时不自动重试。

提问内按钮通过可撤销的 DSH 0.2.x 用户节点适配器定位；弹窗使用会话级 factory，旧消息移除后仍可显示提交结果。

## 来源

基于 [TiJun-Prime/dsh-turn-delete](https://github.com/TiJun-Prime/dsh-turn-delete)，保留 MIT 许可证。本版本未发布到 npm，可通过源码构建安装包。
