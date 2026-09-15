// The transcript. Four kinds of entry: messages, tool cards, model markers, system notices.
//
// The big difference from the hand-written DOM version in phase 1b: nothing
// updates incrementally here. The whole thing renders from the snapshot and
// React does the diffing, so the textNodes / toolNodes bookkeeping is gone.

import { useEffect, useRef } from "react";
import Markdown from "react-markdown";
import type { Entry, MessageEntry, ModelEntry, NoticeEntry, ToolEntry } from "@cinba/contract";

const STATUS_LABEL: Record<string, string> = {
  pending: "awaiting approval",
  running: "running",
  done: "done",
  error: "denied or failed",
};

function Message({
  entry,
  userMessageIndex,
  onEdit,
}: {
  entry: MessageEntry;
  userMessageIndex?: number;
  onEdit?: (userMessageIndex: number, text: string) => void;
}) {
  return (
    <div className={`entry ${entry.role}`}>
      <div className="message-head">
        <div className="role">{entry.role === "user" ? "You" : "Assistant"}</div>
        {userMessageIndex !== undefined && onEdit ? (
          <button
            className="edit-message"
            aria-label="Edit message"
            title="Edit message"
            onClick={() => onEdit(userMessageIndex, entry.text)}
          >
            Edit
          </button>
        ) : null}
      </div>

      {entry.thinking ? (
        <details className="thinking">
          <summary>Thinking</summary>
          <pre>{entry.thinking}</pre>
        </details>
      ) : null}

      {/*
        react-markdown disallows raw HTML by default and builds a React node
        tree rather than pushing strings into the DOM. A <script> in model
        output only ever shows up as text, which is the answer to the very
        concern that made phase 1b postpone Markdown.
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
  const resultRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (entry.status === "running" && entry.result && resultRef.current) {
      resultRef.current.scrollTop = resultRef.current.scrollHeight;
    }
  }, [entry.result, entry.status]);

  return (
    <div className={`tool ${entry.status}`}>
      <div className="tool-head">
        <span className="tool-name">{entry.toolName}</span>
        <span className="tool-status">{STATUS_LABEL[entry.status] ?? entry.status}</span>
      </div>

      {entry.args !== undefined ? (
        <pre className="tool-args">{JSON.stringify(entry.args, null, 2)}</pre>
      ) : null}

      {entry.result ? (
        <pre ref={resultRef} className="tool-result">
          {entry.result}
        </pre>
      ) : null}

      {requestId ? (
        <div className="tool-confirmation">
          {entry.confirmMessage ? (
            <pre className="tool-confirm-reason">{entry.confirmMessage}</pre>
          ) : null}
          <div className="tool-confirm">
            <button className="allow" onClick={() => onRespond(requestId, true)}>
              Allow
            </button>
            <button className="deny" onClick={() => onRespond(requestId, false)}>
              Deny
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function Transcript({
  entries,
  onRespond,
  onEdit,
}: {
  entries: Entry[];
  onRespond: (requestId: string, confirmed: boolean) => void;
  onEdit?: (userMessageIndex: number, text: string) => void;
}) {
  const userMessageIndices = new Map(
    entries
      .filter((entry): entry is MessageEntry => entry.kind === "message" && entry.role === "user")
      .map((entry, index) => [entry, index]),
  );

  return (
    <>
      {entries.map((entry, index) => {
        if (entry.kind === "message") {
          // An assistant turn that goes straight to a tool has no text at all;
          // drawing an empty bubble in front of the tool card says nothing. The
          // same holds for the instant before the first token arrives.
          if (entry.text === "" && entry.thinking === "") {
            return null;
          }
          return (
            <Message
              key={entry.messageId}
              entry={entry}
              userMessageIndex={userMessageIndices.get(entry)}
              onEdit={onEdit}
            />
          );
        }
        if (entry.kind === "tool") {
          return <ToolCard key={entry.toolCallId} entry={entry} onRespond={onRespond} />;
        }
        if (entry.kind === "model") {
          const model = entry as ModelEntry;
          // Same index-as-key reasoning as notices below.
          return (
            <div className="notice" key={`model-${index}`}>
              {model.provider} / {model.modelId}
            </div>
          );
        }
        const notice = entry as NoticeEntry;
        // A notice has no natural id, so fall back to its index: notices are only appended, never edited, so the index is stable.
        return (
          <div className="notice" key={`notice-${index}`}>
            {notice.text}
          </div>
        );
      })}
    </>
  );
}
