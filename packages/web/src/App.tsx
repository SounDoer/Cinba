// The web client's page composition and interaction state.

import { useEffect, useRef, useState } from "react";
import { nameColourIndex } from "@cinba/contract";
import { Transcript } from "./Transcript.tsx";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { SessionPicker } from "./SessionPicker.tsx";
import { ProviderPicker } from "./ProviderPicker.tsx";
import { useCore } from "./use-core.ts";

/** One web colour for each stable slot supplied by the shared naming rules. */
const CORE_COLOURS = ["#3b6fd4", "#2e9166", "#b4642a", "#8b4bc4", "#b03a52", "#2b7f96"];

export function App({ serverUrl }: { serverUrl: string }) {
  const core = useCore(serverUrl);
  const [draft, setDraft] = useState("");
  const [picking, setPicking] = useState(false);
  const [pickingModel, setPickingModel] = useState(false);
  const [pickingSession, setPickingSession] = useState(false);
  const [pickingProvider, setPickingProvider] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [core.snapshot]);

  // Esc aborts even while the textarea is disabled during a reply.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && core.snapshot.busy) {
        event.preventDefault();
        core.client?.abort();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [core.client, core.snapshot.busy]);

  function send() {
    const text = draft.trim();
    if (core.snapshot.busy || text === "") return;
    if (!core.client?.prompt(text)) return;
    setDraft("");
  }

  return (
    <>
      <header>
        <span className="core" title="the machine this interface is talking to">
          <span
            className="core-dot"
            style={{ background: CORE_COLOURS[nameColourIndex(core.coreName)] }}
          />
          {core.connectionState === "connected"
            ? core.coreName || "..."
            : core.connectionState === "connecting"
              ? "Connecting..."
              : "Disconnected"}
        </span>
        <button onClick={() => setPickingSession(true)} disabled={!core.connected}>
          {core.cwd.split(/[\\/]/).pop() || "..."} — conversations
        </button>
        <button
          onClick={() => setPickingModel(true)}
          disabled={!core.connected || core.snapshot.busy}
        >
          Model: {core.model?.id ?? "..."}
        </button>
        <button onClick={() => setPickingProvider(true)} disabled={!core.connected}>
          Providers
        </button>
        <span>
          {core.snapshot.totalTokens} tokens · ${core.snapshot.totalCost.toFixed(4)}
        </span>
      </header>

      <main id="transcript">
        <Transcript
          entries={core.snapshot.entries}
          onRespond={(requestId, confirmed) =>
            core.client?.respondConfirm(requestId, confirmed)
          }
        />
        <div ref={bottomRef} />
      </main>

      <footer>
        <textarea
          id="input"
          rows={3}
          placeholder="Say something (Enter to send, Shift+Enter for a new line)"
          value={draft}
          disabled={!core.connected || core.snapshot.busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        <button onClick={send} disabled={!core.connected || core.snapshot.busy}>
          Send
        </button>
        {core.snapshot.busy ? (
          <button onClick={() => core.client?.abort()} disabled={!core.connected}>
            Stop
          </button>
        ) : null}
      </footer>

      {pickingProvider ? (
        <ProviderPicker
          client={core.client}
          providers={core.providers}
          onClose={() => setPickingProvider(false)}
        />
      ) : null}

      {pickingSession ? (
        <SessionPicker
          client={core.client}
          sessions={core.sessions}
          currentId={core.sessionId}
          onNewHere={() => {
            setPickingSession(false);
            setPicking(true);
          }}
          onClose={() => setPickingSession(false)}
        />
      ) : null}

      {picking ? (
        <ProjectPicker
          client={core.client}
          listing={core.listing}
          startPath={core.cwd}
          onClose={() => setPicking(false)}
        />
      ) : null}

      {pickingModel ? (
        <ModelPicker
          client={core.client}
          models={core.models}
          current={core.model}
          onClose={() => setPickingModel(false)}
        />
      ) : null}
    </>
  );
}
