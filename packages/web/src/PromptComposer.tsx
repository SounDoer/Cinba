// The prompt input and the controls for starting or stopping one turn.

import { useEffect, useRef, useState } from "react";

export function PromptComposer({
  connected,
  busy,
  onSend,
  onAbort,
  editDraft,
  editReady,
  onCancelEdit,
}: {
  connected: boolean;
  busy: boolean;
  onSend: (text: string) => boolean;
  onAbort: () => boolean;
  editDraft?: { userMessageIndex: number; text: string };
  editReady: boolean;
  onCancelEdit: () => void;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editDraft === undefined) return;
    setDraft(editDraft.text);
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

  function send() {
    const text = draft.trim();
    if (busy || !editReady || text === "") return;
    if (onSend(text)) setDraft("");
  }

  return (
    <footer>
      <textarea
        ref={inputRef}
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
      <button onClick={send} disabled={!connected || busy || !editReady}>
        {editDraft === undefined ? "Send" : editReady ? "Send edit" : "Preparing edit..."}
      </button>
      {editDraft !== undefined ? (
        <button onClick={onCancelEdit}>Cancel edit</button>
      ) : null}
      {busy ? (
        <button onClick={onAbort} disabled={!connected}>
          Stop
        </button>
      ) : null}
    </footer>
  );
}
