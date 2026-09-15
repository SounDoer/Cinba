// The prompt input and the controls for starting or stopping one turn.

import { useEffect, useRef, useState } from "react";
import {
  type PendingMessages,
  type RecoveredDraft,
  type SkillCommand,
  type SlashCommand,
  isCommand,
  matchCommands,
} from "@cinba/contract";

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
  skills,
  onCommand,
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
  skills: SkillCommand[];
  onCommand: (command: SlashCommand, text: string) => boolean;
}) {
  const [draft, setDraft] = useState(editDraft?.text ?? "");
  const [selectedCommand, setSelectedCommand] = useState(0);
  const [commandError, setCommandError] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const commandHints = editDraft === undefined ? matchCommands(draft, skills) : [];

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
    if (isCommand(text) && !editDraft) {
      if (busy) {
        setCommandError("Wait until the current work is idle.");
        return;
      }
      const command = commandHints[selectedCommand];
      if (!command) {
        setCommandError(`No such command: ${text}`);
        return;
      }
      sent = onCommand(command, text);
      if (!sent) {
        setCommandError("Command could not be started.");
      }
    } else if (editDraft) {
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
      setSelectedCommand(0);
      setCommandError(undefined);
    }
  }

  function updateDraft(value: string) {
    setDraft(value);
    setSelectedCommand(0);
    setCommandError(undefined);
  }

  let sendLabel = "Send";
  if (editDraft !== undefined) {
    sendLabel = editReady ? "Send edit" : "Preparing edit...";
  } else if (busy) {
    sendLabel = "Steer";
  }

  const hasQueue = queue.steering.length > 0 || queue.followUp.length > 0;

  return (
    <div className="prompt-composer">
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
                    updateDraft(`${draft}${draft ? "\n\n" : ""}${item.text}`);
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
      {commandHints.length > 0 ? (
        <div className="command-menu" aria-label="Commands">
          {commandHints.map((command, index) => (
            <button
              key={`${command.source}-${command.name}`}
              className={index === selectedCommand ? "selected" : ""}
              aria-current={index === selectedCommand}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                updateDraft(`/${command.name} `);
                inputRef.current?.focus();
              }}
            >
              <span>/{command.name}</span>
              <small>{command.summary}</small>
              <em>{command.source === "skill" ? command.scope : "Cinba"}</em>
            </button>
          ))}
        </div>
      ) : null}
      {commandError ? <div className="command-error">{commandError}</div> : null}
      <div className="composer-row">
        <textarea
          ref={inputRef}
          id="input"
          rows={3}
          placeholder="Say something (Enter to send, Alt+Enter after completion, Shift+Enter for a new line)"
          value={draft}
          disabled={!connected}
          onChange={(event) => updateDraft(event.target.value)}
          onKeyDown={(event) => {
            if (commandHints.length > 0 && event.key === "ArrowUp") {
              event.preventDefault();
              setSelectedCommand((selectedCommand + commandHints.length - 1) % commandHints.length);
              return;
            }
            if (commandHints.length > 0 && (event.key === "ArrowDown" || event.key === "Tab")) {
              event.preventDefault();
              setSelectedCommand((selectedCommand + 1) % commandHints.length);
              return;
            }
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
      </div>
    </div>
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
