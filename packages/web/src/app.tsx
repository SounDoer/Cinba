// The web client's page composition and interaction state.

import { useEffect, useRef, useState } from "react";
import {
  COMMANDS,
  type Command,
  type SkillCommand,
  type SlashCommand,
  commandArgument,
  nameColourIndex,
} from "@cinba/contract";
import { Transcript } from "./transcript.tsx";
import { PromptComposer } from "./prompt-composer.tsx";
import { ProjectPicker } from "./project-picker.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { ThinkingPicker } from "./thinking-picker.tsx";
import { SessionPicker } from "./session-picker.tsx";
import { ProviderSettings } from "./provider-settings.tsx";
import { WebToolsSettings } from "./web-tools-settings.tsx";
import { SyncSettings } from "./sync-settings.tsx";
import { StatusBar } from "./status-bar.tsx";
import { useCore } from "./use-core.ts";
import { PickerShell } from "./picker-shell.tsx";

/** One web colour for each stable slot supplied by the shared naming rules. */
const CORE_COLOURS = ["#3b6fd4", "#2e9166", "#b4642a", "#8b4bc4", "#b03a52", "#2b7f96"];

type ActiveOverlay =
  "project" | "model" | "thinking" | "session" | "provider" | "webtools" | "sync" | "help" | null;
type EditTarget = { sessionId: string; userMessageIndex: number; text: string };

export function App({ serverUrl }: { serverUrl: string }) {
  const core = useCore(serverUrl);
  const [activeOverlay, setActiveOverlay] = useState<ActiveOverlay>(null);
  const [storedEditTarget, setStoredEditTarget] = useState<EditTarget | undefined>(undefined);
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
  let connectionLabel = "Disconnected";
  if (core.connected) {
    connectionLabel = core.coreName || "...";
  } else if (core.connectionState === "connecting") {
    connectionLabel = "Connecting...";
  }

  function runCinbaCommand(command: Command, line: string): boolean {
    switch (command.id) {
      case "compact":
        return core.compact();
      case "model":
        if (core.listModels()) {
          setActiveOverlay("model");
          return true;
        }
        return false;
      case "sessions":
        if (core.listSessions()) {
          setActiveOverlay("session");
          return true;
        }
        return false;
      case "thinking":
        setActiveOverlay("thinking");
        return true;
      case "new":
        return core.createConversation(core.cwd);
      case "name": {
        const name = commandArgument(line);
        return name !== "" && core.renameSession(name);
      }
      case "providers":
      case "login":
      case "logout":
        if (core.listProviders()) {
          setActiveOverlay("provider");
          return true;
        }
        return false;
      case "webtools":
        if (core.getWebToolsStatus()) {
          setActiveOverlay("webtools");
          return true;
        }
        return false;
      case "sync":
        setActiveOverlay("sync");
        return true;
      case "help":
        setActiveOverlay("help");
        return true;
    }
  }

  function runSlashCommand(command: SlashCommand, line: string): boolean {
    return command.source === "skill" ? core.prompt(line) : runCinbaCommand(command, line);
  }

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
          {connectionLabel}
        </span>
        <button
          onClick={() => {
            if (core.listSessions()) {
              setActiveOverlay("session");
            }
          }}
          disabled={!core.connected}
        >
          {core.cwd.split(/[\\/]/).pop() || "..."} — conversations
        </button>
        <button
          onClick={() => {
            if (core.listModels()) {
              setActiveOverlay("model");
            }
          }}
          disabled={!core.connected || core.snapshot.busy || core.snapshot.compacting}
        >
          Model: {core.model?.id ?? "..."}
        </button>
        <button
          onClick={() => setActiveOverlay("thinking")}
          disabled={
            !core.connected ||
            core.snapshot.busy ||
            core.snapshot.compacting ||
            core.snapshot.thinking.available.length <= 1
          }
          title={
            core.snapshot.thinking.available.length <= 1
              ? "The current model does not offer adjustable reasoning"
              : "Set reasoning effort for this conversation"
          }
        >
          Thinking: {core.snapshot.thinking.level}
        </button>
        <button
          onClick={() => {
            if (core.listProviders()) {
              setActiveOverlay("provider");
            }
          }}
          disabled={!core.connected}
        >
          Providers
        </button>
        <button
          onClick={() => {
            if (core.getWebToolsStatus()) {
              setActiveOverlay("webtools");
            }
          }}
          disabled={!core.connected}
        >
          Web tools
        </button>
        <button onClick={() => setActiveOverlay("sync")} disabled={!core.connected}>
          Sync
        </button>
      </header>

      <main id="transcript">
        <Transcript
          entries={core.snapshot.entries}
          onRespond={core.respondConfirm}
          onEdit={(userMessageIndex, text) => {
            setStoredEditTarget({ sessionId: core.sessionId, userMessageIndex, text });
            if (core.snapshot.busy) {
              core.abort();
            }
          }}
        />
        <div ref={bottomRef} />
      </main>

      <footer>
        <StatusBar
          snapshot={core.snapshot}
          connectionState={core.connectionState}
          onCompact={core.compact}
          onAbort={core.abort}
          onAbortRetry={core.abortRetry}
        />
        <PromptComposer
          key={
            editTarget
              ? `edit-${editTarget.sessionId}-${editTarget.userMessageIndex}-${editingEntryId ?? "preparing"}`
              : "compose"
          }
          connected={core.connected}
          busy={core.snapshot.busy || core.snapshot.compacting}
          onSend={(text) => {
            const sent = editTarget
              ? editingEntryId !== undefined && core.editMessage(editingEntryId, text)
              : core.prompt(text);
            if (sent) {
              setStoredEditTarget(undefined);
            }
            return sent;
          }}
          onSteer={core.steer}
          onFollowUp={core.followUp}
          onClearQueue={core.clearQueue}
          onAbort={core.snapshot.retry ? core.abortRetry : core.abort}
          editDraft={editTarget}
          editReady={editTarget === undefined || editingEntryId !== undefined}
          onCancelEdit={() => setStoredEditTarget(undefined)}
          queue={core.snapshot.queue}
          recoveredDrafts={core.recoveredDrafts}
          onDismissRecoveredDraft={core.dismissRecoveredDraft}
          skills={core.skills}
          onCommand={runSlashCommand}
        />
      </footer>

      {activeOverlay === "provider" ? (
        <ProviderSettings
          providers={core.providers}
          onSetApiKey={core.setApiKey}
          onClearCredential={core.clearCredential}
          onClose={() => setActiveOverlay(null)}
        />
      ) : null}

      {activeOverlay === "webtools" ? (
        <WebToolsSettings
          status={core.webToolsStatus}
          error={core.webToolsError}
          onSetApiKey={core.setWebToolsApiKey}
          onClearApiKey={core.clearWebToolsApiKey}
          onSetPrimary={core.setWebSearchPrimary}
          onClose={() => setActiveOverlay(null)}
        />
      ) : null}

      {activeOverlay === "sync" ? (
        <SyncSettings serverUrl={serverUrl} onClose={() => setActiveOverlay(null)} />
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

      {activeOverlay === "thinking" ? (
        <ThinkingPicker
          thinking={core.snapshot.thinking}
          onSelect={core.selectThinkingLevel}
          onClose={() => setActiveOverlay(null)}
        />
      ) : null}

      {activeOverlay === "help" ? (
        <CommandHelp skills={core.skills} onClose={() => setActiveOverlay(null)} />
      ) : null}

      {core.projectTrustRequest ? (
        <ProjectTrustDialog
          request={core.projectTrustRequest}
          onAnswer={(trusted) =>
            core.respondProjectTrust(core.projectTrustRequest!.requestId, trusted)
          }
        />
      ) : null}
    </>
  );
}

function CommandHelp({ skills, onClose }: { skills: SkillCommand[]; onClose: () => void }) {
  return (
    <PickerShell label="Commands" onClose={onClose}>
      <h2>Commands</h2>
      <h3>Cinba</h3>
      <dl className="command-help">
        {COMMANDS.map((command) => (
          <div key={command.name}>
            <dt>/{command.name}</dt>
            <dd>{command.summary}</dd>
          </div>
        ))}
      </dl>
      {skills.length > 0 ? (
        <>
          <h3>Skills</h3>
          <dl className="command-help">
            {skills.map((skill) => (
              <div key={skill.name}>
                <dt>/{skill.name}</dt>
                <dd>
                  {skill.summary} ({skill.scope})
                </dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}
      <button onClick={onClose}>Close</button>
    </PickerShell>
  );
}

function ProjectTrustDialog({
  request,
  onAnswer,
}: {
  request: { cwd: string; resources: string[] };
  onAnswer: (trusted: boolean) => void;
}) {
  return (
    <PickerShell label="Project trust" onClose={() => onAnswer(false)}>
      <h2>Trust agent resources in this project?</h2>
      <p>{request.cwd}</p>
      <p>Detected:</p>
      <ul>
        {request.resources.map((resource) => (
          <li key={resource}>{resource}</li>
        ))}
      </ul>
      <p>
        Trusting this folder also trusts Pi settings, system prompts, skills, packages and
        executable extensions added here later.
      </p>
      <div className="picker-actions">
        <button onClick={() => onAnswer(true)}>Trust</button>
        <button onClick={() => onAnswer(false)}>Do not trust</button>
      </div>
    </PickerShell>
  );
}
