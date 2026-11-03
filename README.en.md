# Conversation Controls / 优化对话控件

English | [中文](README.md)

Local `dsh-conversation-controls` extension of `dsh-turn-delete` 0.2.5.

- Delete a completed turn using its trash action. Legacy deletion markers remain supported. Version 0.3.1 also removes deleted turns from the right navigation rail, including after reload, session changes and history paging. A whole-log projection supplies deletion state; a reversible chat component adapter filters both navigation sources. Revalidate the adapter when upgrading DSH because 0.2.x has no public navigation filter API.
- Version 0.4.0 adds Edit immediately before Copy on the latest user prompt. Since 0.4.1, Edit turns that message into an inline text field with Cancel (Esc) and Send (Ctrl/Cmd+Enter) buttons. Sending preserves attachments, removes the previous prompt and its subsequent responses/tool records from the visible chat and model context, then queues the revised prompt to generate a new response. Completed external operations are not undone. The action is disabled while running. A reversible DSH 0.2.x user-node adapter places the action; a session factory keeps the editor alive during replacement and reports recoverable or uncertain submission failures.
- Version 0.4.2 fixes old answers remaining visible after Edit and Send. Session-scoped rules use the durable deletion projection and DSH 0.2.1 turn attributes to hide old prompts, grouped responses, tools and automatic continuation turns without waiting for memoized tail rows to rerender. Reloads and later history mounts preserve this state; other chats are unaffected. Revalidate the host DOM contract when upgrading DSH.
- The original save-only editor beside the input remains available, including on older runtimes. Edit the latest user prompt while the conversation is idle after pausing. Only model-context text changes; the original transcript bubble, attachments, prior responses and tool records remain. Reopening the editor shows the saved text. Saving does not resume execution. Future model requests use the edited prompt.
- Maintenance leases, optimistic sequence checks and persistence flushing protect edits. Running and subagent sessions cannot be edited.
- Request bodies use async iteration, including bodies replayed by the WSL router, fixing the indefinitely pending deletion dialog.

Build with `pnpm install`, `pnpm run build`; verify with `pnpm test` and `pnpm run smoke`. Package with `pnpm pack` and install the tarball using `dsh plugin --profile desktop add -w <tarball>`. Add `dsh-conversation-controls` to the profile bundle list and restart the desktop app. Remove the old plugin bundle if present. Avoid linking a source checkout with development kernel dependencies into the running host.

Based on [TiJun-Prime/dsh-turn-delete](https://github.com/TiJun-Prime/dsh-turn-delete), under the retained MIT license. This version has not been published to npm; build an installable tarball from source.
