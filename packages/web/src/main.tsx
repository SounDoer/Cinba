// The UI entry point: connect to the server, keep a mirror ledger, render.
//
// This same code serves both the browser and the Electron window, which load
// the very same page.

import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CoreClient } from "@cinba/core-client";
import { createSession, nameColourIndex } from "@cinba/contract";
import type {
  ModelRef,
  ProviderStatus,
  Session,
  SessionSummary,
  Snapshot,
} from "@cinba/contract";
import { Transcript } from "./Transcript.tsx";
import { ProjectPicker } from "./ProjectPicker.tsx";
import type { Listing } from "./ProjectPicker.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { SessionPicker } from "./SessionPicker.tsx";
import { ProviderPicker } from "./ProviderPicker.tsx";
import "./style.css";

const EMPTY: Snapshot = { entries: [], totalTokens: 0, totalCost: 0, busy: false };

/**
 * One per colour slot from nameColourIndex. Which slot a core lands on is
 * shared with the terminal; what the slot looks like is not, because the two
 * draw colour nothing alike.
 */
const CORE_COLOURS = ["#3b6fd4", "#2e9166", "#b4642a", "#8b4bc4", "#b03a52", "#2b7f96"];

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
  const [pickingSession, setPickingSession] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[] | undefined>(undefined);
  const [pickingProvider, setPickingProvider] = useState(false);
  const [providers, setProviders] = useState<ProviderStatus[] | undefined>(undefined);
  const [core, setCore] = useState("");

  const coreClientRef = useRef<CoreClient | undefined>(undefined);
  const mirrorRef = useRef<Session>(createSession());
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const socket = new WebSocket(SERVER_URL);

    coreClientRef.current = new CoreClient(socket, {
      onSnapshot: (state) => {
        mirrorRef.current = createSession(state.snapshot);
        setSnapshot(state.snapshot);
        setCwd(state.cwd);
        setModel(state.model);
        setSessionId(state.sessionId);
      },
      onActions: (actions) => {
        for (const action of actions) mirrorRef.current.apply(action);
        setSnapshot(mirrorRef.current.snapshot());
      },
      onDirListing: (next) => setListing(next),
      onModelListing: (next) => setModels(next),
      onModelChanged: (next) => setModel(next),
      onSessionListing: (next) => setSessions(next),
      onSessionOpened: (id) => setSessionId(id),
      onProviderListing: (next) => setProviders(next),
      onCoreIdentity: (name) => setCore(name),
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
        coreClientRef.current?.abort();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [snapshot.busy]);

  function send() {
    const text = draft.trim();
    if (snapshot.busy || text === "") return;
    setDraft("");
    coreClientRef.current?.prompt(text);
  }

  return (
    <>
      <header>
        {/* Which machine this is. Two cores are otherwise identical on screen,
            and each can run any command on its own machine. */}
        <span className="core" title="the machine this interface is talking to">
          <span
            className="core-dot"
            style={{ background: CORE_COLOURS[nameColourIndex(core)] }}
          />
          {core || "..."}
        </span>
        {/* The way in to every conversation, so it carries the current one's project as its label. */}
        <button onClick={() => setPickingSession(true)}>
          {cwd.split(/[\\/]/).pop() || "..."} — conversations
        </button>
        {/* Disabled while busy for the same reason as the input box: do not swap brains mid-sentence. */}
        <button onClick={() => setPickingModel(true)} disabled={snapshot.busy}>
          Model: {model?.id ?? "..."}
        </button>
        <button onClick={() => setPickingProvider(true)}>Providers</button>
        <span>
          {snapshot.totalTokens} tokens · ${snapshot.totalCost.toFixed(4)}
        </span>
      </header>

      <main id="transcript">
        <Transcript
          entries={snapshot.entries}
          onRespond={(requestId, confirmed) =>
            coreClientRef.current?.respondConfirm(requestId, confirmed)
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
        {snapshot.busy ? <button onClick={() => coreClientRef.current?.abort()}>Stop</button> : null}
      </footer>

      {pickingProvider ? (
        <ProviderPicker
          client={coreClientRef.current}
          providers={providers}
          onClose={() => setPickingProvider(false)}
        />
      ) : null}

      {pickingSession ? (
        <SessionPicker
          client={coreClientRef.current}
          sessions={sessions}
          currentId={sessionId}
          onNewHere={() => {
            setPickingSession(false);
            setPicking(true);
          }}
          onClose={() => setPickingSession(false)}
        />
      ) : null}

      {picking ? (
        <ProjectPicker
          client={coreClientRef.current}
          listing={listing}
          startPath={cwd}
          onClose={() => setPicking(false)}
        />
      ) : null}

      {pickingModel ? (
        <ModelPicker
          client={coreClientRef.current}
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
