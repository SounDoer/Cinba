// The conversation list.
//
// The rows come from the core, which reads them out of Pi's session files. That
// is also why deleting one is worded plainly and asks twice: it removes a file
// holding a real conversation, and nothing puts it back.

import { useEffect, useState } from "react";
import { sessionSubtitle, sessionTitle } from "@cinba/contract";
import type { CoreClient } from "@cinba/core-client";
import type { SessionSummary } from "@cinba/contract";

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

export function SessionPicker({
  client,
  sessions,
  currentId,
  onNewHere,
  onClose,
}: {
  client: CoreClient | undefined;
  sessions: SessionSummary[] | undefined;
  currentId: string;
  onNewHere: () => void;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState<string | undefined>(undefined);
  /** The draft name while renaming the current conversation; undefined when not renaming. */
  const [renaming, setRenaming] = useState<string | undefined>(undefined);

  useEffect(() => {
    client?.listSessions();
  }, [client]);

  return (
    <div className="picker" onClick={onClose}>
      <div className="picker-box" onClick={(event) => event.stopPropagation()}>
        <div className="picker-path">
          Conversations are kept until you delete them. A new one appears here once it has been
          spoken to.
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
                        client?.renameSession(renaming.trim());
                        setRenaming(undefined);
                      }
                      if (event.key === "Escape") setRenaming(undefined);
                    }}
                  />
                  <button
                    disabled={renaming.trim() === ""}
                    onClick={() => {
                      client?.renameSession(renaming.trim());
                      setRenaming(undefined);
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
                      client?.deleteSession(session.id);
                      setConfirming(undefined);
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
                    if (!active) client?.openSession(session.id);
                    onClose();
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
      </div>
    </div>
  );
}
