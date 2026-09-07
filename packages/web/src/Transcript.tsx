// 消息流。三种条目：消息、工具卡片、系统提示。
//
// 与阶段 1b 的手写 DOM 版最大的不同：这里不做增量更新，整份从快照渲染，
// 由 React 去 diff。因此不再需要 textNodes / toolNodes 那些节点簿记。

import Markdown from "react-markdown";
import type { Entry, MessageEntry, NoticeEntry, ToolEntry } from "@cinba/core-client";

const STATUS_LABEL: Record<string, string> = {
  pending: "待批准",
  running: "执行中",
  done: "完成",
  error: "被拒绝或出错",
};

function Message({ entry }: { entry: MessageEntry }) {
  return (
    <div className={`entry ${entry.role}`}>
      <div className="role">{entry.role === "user" ? "你" : "助手"}</div>

      {entry.thinking ? (
        <details className="thinking">
          <summary>思考过程</summary>
          <pre>{entry.thinking}</pre>
        </details>
      ) : null}

      {/*
        react-markdown 默认不允许原始 HTML，且构建的是 React 节点树而不是往 DOM 里塞字符串。
        模型输出的 <script> 只会显示成文字——这正是阶段 1b 推迟 Markdown 的那个顾虑的解法。
      */}
      <Markdown>{entry.text}</Markdown>
    </div>
  );
}

function ToolCard({
  entry,
  onRespond,
}: {
  entry: ToolEntry;
  onRespond: (requestId: string, confirmed: boolean) => void;
}) {
  const requestId = entry.confirmRequestId;

  return (
    <div className={`tool ${entry.status}`}>
      <div className="tool-head">
        <span className="tool-name">{entry.toolName}</span>
        <span className="tool-status">{STATUS_LABEL[entry.status] ?? entry.status}</span>
      </div>

      {entry.args !== undefined ? (
        <pre className="tool-args">{JSON.stringify(entry.args, null, 2)}</pre>
      ) : null}

      {entry.result ? <pre className="tool-result">{entry.result}</pre> : null}

      {requestId ? (
        <div className="tool-confirm">
          <button className="allow" onClick={() => onRespond(requestId, true)}>
            允许
          </button>
          <button className="deny" onClick={() => onRespond(requestId, false)}>
            拒绝
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function Transcript({
  entries,
  onRespond,
}: {
  entries: Entry[];
  onRespond: (requestId: string, confirmed: boolean) => void;
}) {
  return (
    <>
      {entries.map((entry, index) => {
        if (entry.kind === "message") {
          return <Message key={entry.messageId} entry={entry} />;
        }
        if (entry.kind === "tool") {
          return <ToolCard key={entry.toolCallId} entry={entry} onRespond={onRespond} />;
        }
        const notice = entry as NoticeEntry;
        // 系统提示没有天然的 id，用序号兜底——它只追加不修改，序号是稳定的。
        return (
          <div className="notice" key={`notice-${index}`}>
            {notice.text}
          </div>
        );
      })}
    </>
  );
}
