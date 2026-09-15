# 中途插话与后续消息设计

日期：2026-09-15
状态：已实施

## 1. 目标

Cinba 在 Pi 工作期间继续接受输入，并把用户明确选择的投递时机交给 Pi：

- `steer`：当前 assistant turn 的工具执行结束后、下一次模型调用前送达，用于立刻纠正方向；
- `followUp`：当前 agent run 完整结束后送达，用于追加下一项工作；
- `clear_queue`：撤回所有尚未消费的两类消息。

Cinba 不自行实现或消费队列。Pi 是队列的真相来源，Cinba 只负责传递用户意图、投影
`queue_update` 状态并提供一致的 Web/TUI 交互。

## 2. 已确认的交互

| 状态 | Enter | Alt+Enter | Shift+Enter | Escape / Stop |
| --- | --- | --- | --- | --- |
| 空闲 | 普通 prompt | 普通 prompt | 换行 | 无操作 |
| 工作中 | steer | follow-up | 换行 | 清空队列后中止 |

Web 在工作期间不再禁用输入框。主按钮随状态显示 `Send` 或 `Steer`，工作期间另有
`After completion` 和 `Stop` 按钮。待处理的 steering 与 follow-up 显示在 composer 上方，
不提前进入正式 transcript；Pi 消费消息并发出普通 user message 事件后，它才进入 transcript。

Pi 的 steering 与 follow-up delivery mode 均沿用默认的 `one-at-a-time`，第一版不增加设置项。
运行期间不排队 Cinba 自己的 slash command，避免把本地命令和 Pi extension command 的立即执行
语义混在一起。

## 3. Stop 与草稿恢复

Pi 的 `abort` 不会丢弃已排队消息，所以 Cinba 的 Stop 定义为：

```text
clear_queue → abort
```

`clear_queue` 返回的原文不得丢失。Web 将每条消息显示在 `Recovered drafts` 区域，保留各自队列内
的顺序与原投递类型，用户可逐条放回编辑器；TUI 保存同一组本地草稿并允许用 Alt+Up 逐条取回。
Pi 分开返回 steering 与 follow-up 两个数组，不提供两类消息交错入队时的全局顺序，因此界面先列
steering、再列 follow-up，不伪造不存在的跨队列顺序。

队列是会话共享状态，同一会话的所有查看者都能看到；恢复草稿是发起清空操作的客户端本地状态，
只返回给该连接，不能突然改写另一客户端的编辑器。

## 4. 协议与状态

Cinba 的 client message 扩展现有 `prompt`，增加可选的 `streamingBehavior: "steer" | "followUp"`。
Server 把它原样映射为 Pi RPC `prompt` 的同名字段。即使前端看到 busy 后到达 Pi 时 Pi 已经空闲，
Pi 也会把这条消息作为普通 prompt 启动，避免单独调用 `steer` 带来的状态竞态。

新增 `clear_queue` client message。`abort` 与 `clear_queue` 都可定向返回 `drafts_recovered` server
message；空数组无需制造界面噪音。

共享 session snapshot 增加完整队列：

```ts
type PendingMessages = {
  steering: string[];
  followUp: string[];
};
```

Pi 的每个 `queue_update` 都含完整数组，因此 `queue_changed` view action 整体替换旧状态，不做追加
或本地推断。Web 刷新和新客户端连接都从 snapshot 得到当前队列。

## 5. 失败与并发

- prompt/steer/follow-up 被 Pi 拒绝时，Core 写入明确 notice，并解除本次错误造成的错误 busy 状态；
- queue command 得到 Pi 成功响应才视为已接受，最终显示仍以随后的 `queue_update` 为准；
- Stop 期间同一 session 不接受新的 prompt，避免另一客户端在 clear 与 abort 之间插入消息；
- clear 失败仍尝试 abort，但必须报告队列可能未被清空；
- Pi 意外退出后，共享队列随进程消失，恢复流程发出已有的重试提示，不伪造旧队列。

## 6. 范围

第一版覆盖 Web、TUI 和复用 Web 的 Desktop，不增加图片排队、单条队列删除、拖动排序、delivery
mode 设置或持久化 recovered drafts。不新增 runtime dependency。
