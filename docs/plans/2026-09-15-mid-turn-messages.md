# 中途插话与后续消息实施计划

日期：2026-09-15
状态：已完成
对应设计：`docs/specs/2026-09-15-mid-turn-messages-design.md`

## 目标与完成标准

- Web/TUI 在 Pi 工作中可发送 steer 和 follow-up；
- 所有客户端从 Core snapshot 与 action 看到同一份 Pi 队列；
- Stop 先清队列再 abort，被清除的文字只回到发起客户端；
- Web 提供 recovered drafts，TUI 可取回本地草稿；
- contract 改动在 Web、TUI、Desktop 全部同步；
- `npm run check` 通过。

## 阶段 1：Agent RPC 与事件折叠

- 扩展 `PiClient.prompt` 的 `streamingBehavior`；
- 增加 `clearQueue` 并验证返回值；
- 把 `queue_update` 折成完整的 `queue_changed` action；
- 添加 PiClient 与 event folder 单元测试。

## 阶段 2：共享 contract 与 ledger

- 定义 delivery behavior、pending messages 和 recovered draft 类型；
- 扩展 client/server message 及运行时校验；
- 在 snapshot 中加入队列，在 ledger 中整体替换；
- 覆盖非法字段、复制隔离和 snapshot rebuild 测试。

## 阶段 3：Server 与 CoreClient

- SessionRegistry 透传 delivery behavior；
- 实现 session 级 clear 与 clear-then-abort，并防止 Stop 中途接收新 prompt；
- Server 将 recovered drafts 只发回操作来源 socket；
- CoreClient 暴露 steer、followUp、clearQueue 和恢复草稿回调；
- 覆盖顺序、失败与 wire message 测试。

## 阶段 4：Web

- busy 时保持 textarea 可编辑；
- 实现 Enter、Alt+Enter、Shift+Enter 和动态按钮；
- 显示 steering/follow-up queue；
- 显示并逐条取回 recovered drafts；
- 保持历史消息编辑原有行为。

## 阶段 5：TUI、三端确认与验收

- busy 时 Enter 发送 steer，Alt+Enter 发送 follow-up；
- Escape 执行 clear-then-abort，Alt+Up 取回 recovered draft；
- 状态栏显示队列与恢复草稿数量；
- 运行 package 级测试，再运行 `npm run check`；
- 启动真实应用，人工确认输入、队列消费、Stop 和恢复行为。
