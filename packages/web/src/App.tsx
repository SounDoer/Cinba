// The web client's page composition and interaction state.

import { useEffect, useRef, useState } from "react";
import { nameColourIndex } from "@cinba/contract";
import { Transcript } from "./Transcript.tsx";
import { PromptComposer } from "./PromptComposer.tsx";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { SessionPicker } from "./SessionPicker.tsx";
import { ProviderSettings } from "./ProviderSettings.tsx";
import { useCore } from "./use-core.ts";

/** One web colour for each stable slot supplied by the shared naming rules. */
const CORE_COLOURS = ["#3b6fd4", "#2e9166", "#b4642a", "#8b4bc4", "#b03a52", "#2b7f96"];

type ActiveOverlay = "project" | "model" | "session" | "provider" | null;
type EditTarget = { sessionId: string; userMessageIndex: number; text: string };

export function App({ serverUrl }: { serverUrl: string }) {
  const core = useCore(serverUrl);
  const [activeOverlay, setActiveOverlay] = useState<ActiveOverlay>(null);
  const [storedEditTarget, setEditTarget] = useState<EditTarget | undefined>(undefined);
  const bottomRef = useRef<HTMLDivElement>(null);
  const editTarget = storedEditTarget?.sessionId === core.sessionId ? storedEditTarget : undefined;
  const editingMessage = editTarget
    ? core.snapshot.entries.filter((entry) => entry.kind === "message" && entry.role === "user")[
        editTarget.userMessageIndex
      ]
    : undefined;
  const editingEntryId =
    editingMessage?.kind === "message" && editingMessage.stableId
      ? editingMessage.messageId
      : undefined;

  // The snapshot is an intentional trigger: streaming output should keep the newest text visible.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [core.snapshot]); // oxlint-disable-line react/exhaustive-effect-dependencies

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
            if (core.listSessions()) setActiveOverlay("session");
          }}
          disabled={!core.connected}
        >
          {core.cwd.split(/[\\/]/).pop() || "..."} — conversations
        </button>
        <button
          onClick={() => {
            if (core.listModels()) setActiveOverlay("model");
          }}
          disabled={!core.connected || core.snapshot.busy}
        >
          Model: {core.model?.id ?? "..."}
        </button>
        <button
          onClick={() => {
            if (core.listProviders()) setActiveOverlay("provider");
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
          onEdit={(userMessageIndex, text) => {
            setEditTarget({ sessionId: core.sessionId, userMessageIndex, text });
            if (core.snapshot.busy) core.abort();
          }}
        />
        <div ref={bottomRef} />
      </main>

      <PromptComposer
        key={
          editTarget
            ? `edit-${editTarget.sessionId}-${editTarget.userMessageIndex}-${editingEntryId ?? "preparing"}`
            : "compose"
        }
        connected={core.connected}
        busy={core.snapshot.busy}
        onSend={(text) => {
          const sent = editTarget
            ? editingEntryId !== undefined && core.editMessage(editingEntryId, text)
            : core.prompt(text);
          if (sent) setEditTarget(undefined);
          return sent;
        }}
        onAbort={core.abort}
        editDraft={editTarget}
        editReady={editTarget === undefined || editingEntryId !== undefined}
        onCancelEdit={() => setEditTarget(undefined)}
      />

      {activeOverlay === "provider" ? (
        <ProviderSettings
          providers={core.providers}
          onSetApiKey={core.setApiKey}
          onClearCredential={core.clearCredential}
          onClose={() => setActiveOverlay(null)}
        />
      ) : null}

      {activeOverlay === "session" ? (
        <SessionPicker
          sessions={core.sessions}
          currentId={core.sessionId}
          onOpen={core.openSession}
          onRename={core.renameSession}
          onDelete={core.deleteSession}
          onNewHere={() => {
            setActiveOverlay("project");
          }}
          onClose={() => setActiveOverlay(null)}
        />
      ) : null}

      {activeOverlay === "project" ? (
        <ProjectPicker
          listing={core.listing}
          startPath={core.cwd}
          onListDirectory={core.listDirectory}
          onCreateConversation={core.createConversation}
          onClose={() => setActiveOverlay(null)}
        />
      ) : null}

      {activeOverlay === "model" ? (
        <ModelPicker
          models={core.models}
          current={core.model}
          onSelect={core.selectModel}
          onClose={() => setActiveOverlay(null)}
        />
      ) : null}
    </>
  );
}
