// The web client's page composition and interaction state.

import { useEffect, useRef, useState } from "react";
import { nameColourIndex } from "@cinba/contract";
import { Transcript } from "./Transcript.tsx";
import { PromptComposer } from "./PromptComposer.tsx";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { SessionPicker } from "./SessionPicker.tsx";
import { ProviderPicker } from "./ProviderPicker.tsx";
import { useCore } from "./use-core.ts";

/** One web colour for each stable slot supplied by the shared naming rules. */
const CORE_COLOURS = ["#3b6fd4", "#2e9166", "#b4642a", "#8b4bc4", "#b03a52", "#2b7f96"];

type ActivePicker = "project" | "model" | "session" | "provider" | null;

export function App({ serverUrl }: { serverUrl: string }) {
  const core = useCore(serverUrl);
  const [activePicker, setActivePicker] = useState<ActivePicker>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [core.snapshot]);

  return (
    <>
      <header>
        <span className="core" title="the machine this interface is talking to">
          <span
            className="core-dot"
            style={{ background: CORE_COLOURS[nameColourIndex(core.coreName)] }}
          />
          {core.connected
            ? core.coreName || "..."
            : core.connectionState === "connecting"
              ? "Connecting..."
              : "Disconnected"}
        </span>
        <button
          onClick={() => {
            if (core.listSessions()) setActivePicker("session");
          }}
          disabled={!core.connected}
        >
          {core.cwd.split(/[\\/]/).pop() || "..."} — conversations
        </button>
        <button
          onClick={() => {
            if (core.listModels()) setActivePicker("model");
          }}
          disabled={!core.connected || core.snapshot.busy}
        >
          Model: {core.model?.id ?? "..."}
        </button>
        <button
          onClick={() => {
            if (core.listProviders()) setActivePicker("provider");
          }}
          disabled={!core.connected}
        >
          Providers
        </button>
        <span>
          {core.snapshot.totalTokens} tokens · ${core.snapshot.totalCost.toFixed(4)}
        </span>
      </header>

      <main id="transcript">
        <Transcript
          entries={core.snapshot.entries}
          onRespond={core.respondConfirm}
        />
        <div ref={bottomRef} />
      </main>

      <PromptComposer
        connected={core.connected}
        busy={core.snapshot.busy}
        onSend={core.prompt}
        onAbort={core.abort}
      />

      {activePicker === "provider" ? (
        <ProviderPicker
          providers={core.providers}
          onSetApiKey={core.setApiKey}
          onClearCredential={core.clearCredential}
          onClose={() => setActivePicker(null)}
        />
      ) : null}

      {activePicker === "session" ? (
        <SessionPicker
          sessions={core.sessions}
          currentId={core.sessionId}
          onOpen={core.openSession}
          onRename={core.renameSession}
          onDelete={core.deleteSession}
          onNewHere={() => {
            setActivePicker("project");
          }}
          onClose={() => setActivePicker(null)}
        />
      ) : null}

      {activePicker === "project" ? (
        <ProjectPicker
          listing={core.listing}
          startPath={core.cwd}
          onListDirectory={core.listDirectory}
          onCreateConversation={core.createConversation}
          onClose={() => setActivePicker(null)}
        />
      ) : null}

      {activePicker === "model" ? (
        <ModelPicker
          models={core.models}
          current={core.model}
          onSelect={core.selectModel}
          onClose={() => setActivePicker(null)}
        />
      ) : null}
    </>
  );
}
