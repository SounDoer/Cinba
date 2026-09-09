// Owns every live conversation and the Pi process behind it.
// Network clients observe this state through callbacks; no WebSocket enters here.

import { existsSync } from "node:fs";
import {
  createEventFolder,
  foldSessionEntries,
  foldUiRequest,
  listSessions as storedSessions,
  PiClient,
  startPi,
  StdioTransport,
} from "@cinba/agent";
import type { CoreEvent } from "@cinba/agent";
import { createSession, sameTranscript } from "@cinba/contract";
import type { ModelRef, ServerMessage, Session, SessionSummary, ViewAction } from "@cinba/contract";

export type LiveSession = {
  readonly id: string;
  readonly cwd: string;
  ledger: Session;
  model: ModelRef | undefined;
  pendingConfirms: Map<string, (confirmed: boolean) => void>;
  idleSince: number | undefined;
  staleCredentials: boolean;
};

type ManagedSession = LiveSession & {
  pi: PiClient;
  fold: (event: CoreEvent) => ViewAction[];
  outbox: ViewAction[];
  flushTimer: NodeJS.Timeout | undefined;
  storedActions: ViewAction[];
  reconciledUpTo: string | undefined;
};

export type OpenSessionOptions = {
  sessionPath?: string;
  cwd: string;
  model?: ModelRef;
};

export type PiLaunch = {
  pi: PiClient;
  failed: Promise<undefined>;
};

export type SessionRegistry = {
  get(id: string): LiveSession | undefined;
  values(): LiveSession[];
  readonly size: number;
  list(cwd?: string): Promise<SessionSummary[]>;
  open(options: OpenSessionOptions): Promise<LiveSession | undefined>;
  stop(id: string): void;
  closeAll(): void;
  emit(session: LiveSession, actions: ViewAction[]): void;
  snapshot(session: LiveSession): ServerMessage;
  prompt(session: LiveSession, text: string): void;
  abort(session: LiveSession): void;
  respondToConfirmation(
    session: LiveSession,
    requestId: string,
    confirmed: boolean,
  ): void;
  listModels(session: LiveSession): Promise<ModelRef[]>;
  setModel(session: LiveSession, model: ModelRef): Promise<boolean>;
  rename(session: LiveSession, name: string): Promise<boolean>;
};

export type SessionRegistryOptions = {
  defaultModel: () => ModelRef | undefined;
  onActions: (sessionId: string, actions: ViewAction[]) => void;
  onSnapshot: (sessionId: string, snapshot: ServerMessage) => void;
  launchPi?: (options: OpenSessionOptions) => PiLaunch;
  flushIntervalMs?: number;
};

function launchPiProcess(options: OpenSessionOptions): PiLaunch {
  const starting = options.model;
  const child = startPi({
    cwd: options.cwd,
    provider: starting?.provider,
    model: starting?.id,
    sessionPath: options.sessionPath,
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => console.error("[pi]", chunk.trimEnd()));

  const failed = new Promise<undefined>((resolve) => {
    child.on("error", (error: Error) => {
      console.error(`[cinba] Pi failed to start in ${options.cwd}:`, error.message);
      resolve(undefined);
    });
  });

  return { pi: new PiClient(new StdioTransport(child)), failed };
}

export function createSessionRegistry(options: SessionRegistryOptions): SessionRegistry {
  const live = new Map<string, ManagedSession>();
  const launchPi = options.launchPi ?? launchPiProcess;
  const flushIntervalMs = options.flushIntervalMs ?? 30;

  function emitManaged(session: ManagedSession, actions: ViewAction[]): void {
    if (actions.length === 0) return;
    for (const action of actions) session.ledger.apply(action);
    session.outbox.push(...actions);

    if (session.flushTimer) return;
    session.flushTimer = setTimeout(() => {
      session.flushTimer = undefined;
      const batch = session.outbox;
      session.outbox = [];
      if (batch.length > 0) options.onActions(session.id, batch);
    }, flushIntervalMs);
  }

  function snapshot(session: LiveSession): ServerMessage {
    return {
      type: "snapshot",
      snapshot: session.ledger.snapshot(),
      cwd: session.cwd,
      sessionId: session.id,
      model: session.model,
    };
  }

  async function list(cwd?: string): Promise<SessionSummary[]> {
    const sessions = await storedSessions(cwd);
    return sessions.map((session) => ({
      id: session.id,
      cwd: session.cwd,
      name: session.name,
      messageCount: session.messageCount,
      firstMessage: session.firstMessage,
      modified: session.modified.toISOString(),
    }));
  }

  async function absorb(session: ManagedSession): Promise<void> {
    const response = await session.pi.getEntries(session.reconciledUpTo);
    const entries = (response.data as { entries?: unknown } | undefined)?.entries;
    if (!Array.isArray(entries) || entries.length === 0) return;

    session.storedActions.push(...foldSessionEntries(entries));
    const last = entries.at(-1) as { id?: unknown } | undefined;
    if (typeof last?.id === "string") session.reconciledUpTo = last.id;
  }

  async function reconcile(session: ManagedSession): Promise<void> {
    await absorb(session);
    const truth = createSession();
    for (const action of session.storedActions) truth.apply(action);

    if (sameTranscript(session.ledger.snapshot().entries, truth.snapshot().entries)) return;
    console.warn(`[cinba] transcript drifted in ${session.id}; taking Pi's copy`);
    session.ledger = truth;
    options.onSnapshot(session.id, snapshot(session));
  }

  async function open(openOptions: OpenSessionOptions): Promise<LiveSession | undefined> {
    if (!existsSync(openOptions.cwd)) {
      console.error(`[cinba] cannot start there, the directory is gone: ${openOptions.cwd}`);
      return undefined;
    }

    console.log(
      `[cinba] starting Pi in ${openOptions.cwd}${openOptions.sessionPath ? " (resuming)" : ""}`,
    );
    const starting = openOptions.model ?? options.defaultModel();
    const launch = launchPi({ ...openOptions, model: starting });
    const state = await Promise.race([launch.pi.getState(), launch.failed]);
    if (!state) return undefined;

    const data = state.data as
      | { sessionId?: unknown; model?: { provider?: unknown; id?: unknown } }
      | undefined;
    if (typeof data?.sessionId !== "string") {
      console.error("[cinba] Pi did not report a session id; abandoning this start");
      void launch.pi.close();
      return undefined;
    }

    const session: ManagedSession = {
      id: data.sessionId,
      cwd: openOptions.cwd,
      pi: launch.pi,
      ledger: createSession(),
      fold: createEventFolder(),
      model:
        typeof data.model?.provider === "string" && typeof data.model.id === "string"
          ? { provider: data.model.provider, id: data.model.id }
          : undefined,
      pendingConfirms: new Map(),
      outbox: [],
      flushTimer: undefined,
      storedActions: [],
      reconciledUpTo: undefined,
      idleSince: undefined,
      staleCredentials: false,
    };

    launch.pi.onEvent((event) => {
      emitManaged(session, session.fold(event));
      if (event.type === "agent_settled") void reconcile(session);
    });
    launch.pi.onUiRequest(async (request) => {
      const action = foldUiRequest(request);
      if (!action) return { cancelled: true };
      emitManaged(session, [action]);
      const confirmed = await new Promise<boolean>((resolve) => {
        session.pendingConfirms.set(request.id, resolve);
      });
      return { confirmed };
    });

    await absorb(session);
    for (const action of session.storedActions) session.ledger.apply(action);
    live.set(session.id, session);
    return session;
  }

  function stop(id: string): void {
    const session = live.get(id);
    if (!session) return;
    if (session.flushTimer) clearTimeout(session.flushTimer);
    void session.pi.close();
    live.delete(id);
  }

  function findManaged(session: LiveSession): ManagedSession | undefined {
    return live.get(session.id);
  }

  function emit(session: LiveSession, actions: ViewAction[]): void {
    const managed = findManaged(session);
    if (managed) emitManaged(managed, actions);
  }

  function prompt(session: LiveSession, message: string): void {
    const managed = findManaged(session);
    if (!managed) return;
    emitManaged(managed, [{ type: "busy_changed", busy: true }]);
    void managed.pi.prompt(message);
  }

  function abort(session: LiveSession): void {
    const managed = findManaged(session);
    if (!managed) return;
    void managed.pi.abort();
    emitManaged(managed, [{ type: "notice", text: "aborted" }]);
  }

  function respondToConfirmation(
    session: LiveSession,
    requestId: string,
    confirmed: boolean,
  ): void {
    const managed = findManaged(session);
    const resolve = managed?.pendingConfirms.get(requestId);
    if (!managed || !resolve) return;
    managed.pendingConfirms.delete(requestId);

    if (confirmed) {
      const pending = managed.ledger
        .snapshot()
        .entries.find((entry) => entry.kind === "tool" && entry.confirmRequestId === requestId);
      if (pending?.kind === "tool") {
        emitManaged(managed, [
          {
            type: "tool_changed",
            toolCallId: pending.toolCallId,
            toolName: pending.toolName,
            status: "running",
          },
        ]);
      }
    }

    resolve(confirmed);
  }

  async function listModels(session: LiveSession): Promise<ModelRef[]> {
    const managed = findManaged(session);
    if (!managed) return [];
    const response = await managed.pi.getAvailableModels();
    const raw = (response.data as { models?: unknown } | undefined)?.models;
    return (Array.isArray(raw) ? raw : []).flatMap((item) => {
      const candidate = item as { provider?: unknown; id?: unknown };
      return typeof candidate.provider === "string" && typeof candidate.id === "string"
        ? [{ provider: candidate.provider, id: candidate.id }]
        : [];
    });
  }

  async function setModel(session: LiveSession, model: ModelRef): Promise<boolean> {
    const managed = findManaged(session);
    if (!managed) return false;
    const response = await managed.pi.setModel(model.provider, model.id);
    if (!response.success) {
      emitManaged(managed, [
        { type: "notice", text: `model not switched: ${String(response.error)}` },
      ]);
      return false;
    }

    managed.model = model;
    emitManaged(managed, [
      { type: "model_in_use", provider: model.provider, modelId: model.id },
    ]);
    return true;
  }

  async function rename(session: LiveSession, name: string): Promise<boolean> {
    const managed = findManaged(session);
    if (!managed) return false;
    const response = await managed.pi.setSessionName(name);
    if (!response.success) {
      emitManaged(managed, [
        { type: "notice", text: `not renamed: ${String(response.error)}` },
      ]);
      return false;
    }
    emitManaged(managed, [{ type: "notice", text: `named "${name}"` }]);
    return true;
  }

  return {
    get: (id) => live.get(id),
    values: () => [...live.values()],
    get size() {
      return live.size;
    },
    list,
    open,
    stop,
    closeAll: () => {
      for (const id of [...live.keys()]) stop(id);
    },
    emit,
    snapshot,
    prompt,
    abort,
    respondToConfirmation,
    listModels,
    setModel,
    rename,
  };
}
