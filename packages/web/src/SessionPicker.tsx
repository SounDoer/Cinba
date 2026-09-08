// The conversation list.
//
// The rows come from the core, which reads them out of Pi's session files. That
// is also why deleting one is worded plainly and asks twice: it removes a file
// holding a real conversation, and nothing puts it back.

import { useEffect, useState } from "react";
import type { RemoteSession, SessionSummary } from "@cinba/core-client";

/** The last path segment, whichever slash the server's platform uses. */
function projectName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

export function SessionPicker({
  remote,
  sessions,
  currentId,
  onNewHere,
  onClose,
}: {
  remote: RemoteSession | undefined;
  sessions: SessionSummary[] | undefined;
  currentId: string;
  onNewHere: () => void;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState<string | undefined>(undefined);

  useEffect(() => {
    remote?.listSessions();
  }, [remote]);

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

            if (confirming === session.id) {
              return (
                <div className="picker-item" key={session.id}>
                  Delete this conversation for good?{" "}
                  <button
                    onClick={() => {
                      remote?.deleteSession(session.id);
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
                    if (!active) remote?.openSession(session.id);
                    onClose();
                  }}
                >
                  <span className="session-title">
                    {active ? "● " : ""}
                    {session.name || session.firstMessage || "(nothing said yet)"}
                  </span>
                  <span className="session-meta">
                    {projectName(session.cwd)} · {session.messageCount} messages ·{" "}
                    {when(session.modified)}
                  </span>
                </button>
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
