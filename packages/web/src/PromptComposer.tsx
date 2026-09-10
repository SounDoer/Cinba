// The prompt input and the controls for starting or stopping one turn.

import { useEffect, useState } from "react";

export function PromptComposer({
  connected,
  busy,
  onSend,
  onAbort,
}: {
  connected: boolean;
  busy: boolean;
  onSend: (text: string) => boolean;
  onAbort: () => boolean;
}) {
  const [draft, setDraft] = useState("");

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

  function send() {
    const text = draft.trim();
    if (busy || text === "") return;
    if (onSend(text)) setDraft("");
  }

  return (
    <footer>
      <textarea
        id="input"
        rows={3}
        placeholder="Say something (Enter to send, Shift+Enter for a new line)"
        value={draft}
        disabled={!connected || busy}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            send();
          }
        }}
      />
      <button onClick={send} disabled={!connected || busy}>
        Send
      </button>
      {busy ? (
        <button onClick={onAbort} disabled={!connected}>
          Stop
        </button>
      ) : null}
    </footer>
  );
}
