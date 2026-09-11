// The conversation list.
//
// The rows come from the core, which reads them out of Pi's session files. That
// is also why deleting one is worded plainly and asks twice: it removes a file
// holding a real conversation, and nothing puts it back.

import { useState } from "react";
import { type SessionSummary, sessionSubtitle, sessionTitle } from "@cinba/contract";
import { PickerShell } from "./picker-shell.tsx";

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

export function SessionPicker({
  sessions,
  currentId,
  onOpen,
  onRename,
  onDelete,
  onNewHere,
  onClose,
}: {
  sessions: SessionSummary[] | undefined;
  currentId: string;
  onOpen: (sessionId: string) => boolean;
  onRename: (name: string) => boolean;
  onDelete: (sessionId: string) => boolean;
  onNewHere: () => void;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState<string | undefined>(undefined);
  /** The draft name while renaming the current conversation; undefined when not renaming. */
  const [renaming, setRenaming] = useState<string | undefined>(undefined);

  return (
    <PickerShell label="conversation picker" onClose={onClose}>
      <div className="picker-path">
        Conversations are kept until you delete them. A new one appears here once it has been spoken
        to.
      </div>

      <div className="picker-list">
        {sessions === undefined ? <div className="picker-item">Loading...</div> : null}

        {sessions?.map((session) => {
          const active = session.id === currentId;

          if (active && renaming !== undefined) {
            return (
              <div className="picker-item session-row" key={session.id}>
                <input
                  className="session-rename"
                  autoFocus
                  value={renaming}
                  onChange={(event) => setRenaming(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && renaming.trim() !== "") {
                      if (onRename(renaming.trim())) {
                        setRenaming(undefined);
                      }
                    }
                    if (event.key === "Escape") {
                      setRenaming(undefined);
                    }
                  }}
                />
                <button
                  disabled={renaming.trim() === ""}
                  onClick={() => {
                    if (onRename(renaming.trim())) {
                      setRenaming(undefined);
                    }
                  }}
                >
                  Save
                </button>
                <button onClick={() => setRenaming(undefined)}>Cancel</button>
              </div>
            );
          }

          if (confirming === session.id) {
            return (
              <div className="picker-item" key={session.id}>
                Delete this conversation for good?{" "}
                <button
                  onClick={() => {
                    if (onDelete(session.id)) {
                      setConfirming(undefined);
                    }
                  }}
                >
                  Delete
                </button>{" "}
                <button onClick={() => setConfirming(undefined)}>Keep</button>
              </div>
            );
          }

          return (
            <div className="picker-item session-row" key={session.id}>
              <button
                className="session-open"
                onClick={() => {
                  if (active || onOpen(session.id)) {
                    onClose();
                  }
                }}
              >
                <span className="session-title">
                  {active ? "● " : ""}
                  {sessionTitle(session)}
                </span>
                <span className="session-meta">
                  {sessionSubtitle(session)} · {when(session.modified)}
                </span>
              </button>
              {/* Only the conversation you are in: renaming goes through its
                    own Pi, and the others do not have one running. */}
              {active ? (
                <button onClick={() => setRenaming(sessionTitle(session))}>Rename</button>
              ) : null}
              <button className="session-delete" onClick={() => setConfirming(session.id)}>
                Delete
              </button>
            </div>
          );
        })}

        {sessions?.length === 0 ? (
          <div className="picker-item">(no conversations stored yet)</div>
        ) : null}
      </div>

      <div className="picker-actions">
        <button onClick={onClose}>Cancel</button>
        <button onClick={onNewHere}>New conversation...</button>
      </div>
    </PickerShell>
  );
}
