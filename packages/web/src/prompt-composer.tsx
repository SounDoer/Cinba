// The prompt input and the controls for starting or stopping one turn.

import { useEffect, useRef, useState } from "react";
import type { PendingMessages, RecoveredDraft } from "@cinba/contract";

export function PromptComposer({
  connected,
  busy,
  onSend,
  onSteer,
  onFollowUp,
  onClearQueue,
  onAbort,
  editDraft,
  editReady,
  onCancelEdit,
  queue,
  recoveredDrafts,
  onDismissRecoveredDraft,
}: {
  connected: boolean;
  busy: boolean;
  onSend: (text: string) => boolean;
  onSteer: (text: string) => boolean;
  onFollowUp: (text: string) => boolean;
  onClearQueue: () => boolean;
  onAbort: () => boolean;
  editDraft?: { userMessageIndex: number; text: string };
  editReady: boolean;
  onCancelEdit: () => void;
  queue: PendingMessages;
  recoveredDrafts: RecoveredDraft[];
  onDismissRecoveredDraft: (index: number) => void;
}) {
  const [draft, setDraft] = useState(editDraft?.text ?? "");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editDraft === undefined) {
      return;
    }
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(editDraft.text.length, editDraft.text.length);
    });
  }, [editDraft]);

  // Esc remains available while the textarea is disabled during a reply.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && busy) {
        event.preventDefault();
        onAbort();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onAbort]);

  function send(delivery: "default" | "followUp" = "default") {
    const text = draft.trim();
    if (!editReady || text === "") {
      return;
    }
    let sent: boolean;
    if (editDraft) {
      sent = !busy && onSend(text);
    } else if (!busy) {
      sent = onSend(text);
    } else if (delivery === "followUp") {
      sent = onFollowUp(text);
    } else {
      sent = onSteer(text);
    }
    if (sent) {
      setDraft("");
    }
  }

  let sendLabel = "Send";
  if (editDraft !== undefined) {
    sendLabel = editReady ? "Send edit" : "Preparing edit...";
  } else if (busy) {
    sendLabel = "Steer";
  }

  const hasQueue = queue.steering.length > 0 || queue.followUp.length > 0;

  return (
    <footer>
      {hasQueue || recoveredDrafts.length > 0 ? (
        <div className="message-queues">
          {queue.steering.length > 0 ? (
            <QueueList title="Steering next" messages={queue.steering} />
          ) : null}
          {queue.followUp.length > 0 ? (
            <QueueList title="After completion" messages={queue.followUp} />
          ) : null}
          {hasQueue ? (
            <button className="queue-clear" onClick={onClearQueue} disabled={!connected}>
              Clear queued messages
            </button>
          ) : null}
          {recoveredDrafts.length > 0 ? (
            <section className="recovered-drafts">
              <strong>Recovered drafts</strong>
              {recoveredDrafts.map((item, index) => (
                <button
                  key={`${item.behavior}-${index}-${item.text}`}
                  onClick={() => {
                    setDraft((current) => `${current}${current ? "\n\n" : ""}${item.text}`);
                    onDismissRecoveredDraft(index);
                    inputRef.current?.focus();
                  }}
                >
                  <span>{item.behavior === "steer" ? "Steer" : "Follow-up"}</span>
                  {item.text}
                </button>
              ))}
            </section>
          ) : null}
        </div>
      ) : null}
      <div className="composer-row">
        <textarea
          ref={inputRef}
          id="input"
          rows={3}
          placeholder="Say something (Enter to send, Alt+Enter after completion, Shift+Enter for a new line)"
          value={draft}
          disabled={!connected}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send(event.altKey ? "followUp" : "default");
            }
          }}
        />
        <button onClick={() => send()} disabled={!connected || !editReady || (busy && !!editDraft)}>
          {sendLabel}
        </button>
        {busy && editDraft === undefined ? (
          <button onClick={() => send("followUp")} disabled={!connected || draft.trim() === ""}>
            After completion
          </button>
        ) : null}
        {editDraft !== undefined ? <button onClick={onCancelEdit}>Cancel edit</button> : null}
        {busy ? (
          <button onClick={onAbort} disabled={!connected}>
            Stop
          </button>
        ) : null}
      </div>
    </footer>
  );
}

function QueueList({ title, messages }: { title: string; messages: string[] }) {
  return (
    <section className="pending-messages">
      <strong>{title}</strong>
      <ol>
        {messages.map((message, index) => (
          <li key={`${index}-${message}`}>{message}</li>
        ))}
      </ol>
    </section>
  );
}
