// The UI entry point: connect to the server, keep a mirror ledger, render.
//
// This same code serves both the browser and the Electron window, which load
// the very same page.

import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createSession, RemoteSession } from "@cinba/core-client";
import type { ModelRef, Session, Snapshot } from "@cinba/core-client";
import { Transcript } from "./Transcript.tsx";
import { ProjectPicker } from "./ProjectPicker.tsx";
import type { Listing } from "./ProjectPicker.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import "./style.css";

const EMPTY: Snapshot = { entries: [], totalTokens: 0, totalCost: 0, busy: false };

/** Connect back to wherever the page came from, so neither the browser nor Electron needs an address configured. */
const SERVER_URL = `ws://${location.host}/ws`;

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [cwd, setCwd] = useState("");
  const [draft, setDraft] = useState("");
  const [picking, setPicking] = useState(false);
  const [listing, setListing] = useState<Listing | undefined>(undefined);
  const [pickingModel, setPickingModel] = useState(false);
  const [model, setModel] = useState<ModelRef | undefined>(undefined);
  const [models, setModels] = useState<ModelRef[] | undefined>(undefined);

  const remoteRef = useRef<RemoteSession | undefined>(undefined);
  const mirrorRef = useRef<Session>(createSession());
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const socket = new WebSocket(SERVER_URL);

    remoteRef.current = new RemoteSession(socket, {
      onSnapshot: (state) => {
        mirrorRef.current = createSession(state.snapshot);
        setSnapshot(state.snapshot);
        setCwd(state.cwd);
        setModel(state.model);
      },
      onActions: (actions) => {
        for (const action of actions) mirrorRef.current.apply(action);
        setSnapshot(mirrorRef.current.snapshot());
      },
      onDirListing: (next) => setListing(next),
      onModelListing: (next) => setModels(next),
      onModelChanged: (next) => setModel(next),
    });

    return () => socket.close();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [snapshot]);

  // Esc aborts. It has to hang on window rather than the textarea: the textarea
  // is disabled while a reply is in flight, and disabled elements receive no
  // keyboard events. The phase 1b GUI fell into exactly this hole.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && snapshot.busy) {
        event.preventDefault();
        remoteRef.current?.abort();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [snapshot.busy]);

  function send() {
    const text = draft.trim();
    if (snapshot.busy || text === "") return;
    setDraft("");
    remoteRef.current?.prompt(text);
  }

  return (
    <>
      <header>
        <button onClick={() => setPicking(true)}>
          Project: {cwd.split(/[\\/]/).pop() || "..."}
        </button>
        {/* Disabled while busy for the same reason as the input box: do not swap brains mid-sentence. */}
        <button onClick={() => setPickingModel(true)} disabled={snapshot.busy}>
          Model: {model?.id ?? "..."}
        </button>
        <span>
          {snapshot.totalTokens} tokens · ${snapshot.totalCost.toFixed(4)}
        </span>
      </header>

      <main id="transcript">
        <Transcript
          entries={snapshot.entries}
          onRespond={(requestId, confirmed) =>
            remoteRef.current?.respondConfirm(requestId, confirmed)
          }
        />
        <div ref={bottomRef} />
      </main>

      <footer>
        <textarea
          rows={3}
          placeholder="Say something (Enter to send, Shift+Enter for a new line)"
          value={draft}
          disabled={snapshot.busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        <button onClick={send} disabled={snapshot.busy}>
          Send
        </button>
        {snapshot.busy ? <button onClick={() => remoteRef.current?.abort()}>Stop</button> : null}
      </footer>

      {picking ? (
        <ProjectPicker
          remote={remoteRef.current}
          listing={listing}
          startPath={cwd}
          onClose={() => setPicking(false)}
        />
      ) : null}

      {pickingModel ? (
        <ModelPicker
          remote={remoteRef.current}
          models={models}
          current={model}
          onClose={() => setPickingModel(false)}
        />
      ) : null}
    </>
  );
}

// Hot reload re-executes this module, and createRoot must not run twice on the
// same container. Reuse the existing root, or development hits state confusion
// that looks exactly like "clicking does nothing".
const container = document.getElementById("root")!;
const globals = globalThis as { __cinbaRoot?: ReturnType<typeof createRoot> };
globals.__cinbaRoot ??= createRoot(container);
globals.__cinbaRoot.render(<App />);
