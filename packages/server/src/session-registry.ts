// Owns every live conversation and the Pi process behind it.
// Network clients observe this state through callbacks; no WebSocket enters here.

import { existsSync } from "node:fs";
import {
  type CoreEvent,
  PiClient,
  StdioTransport,
  activeBranchEntries,
  createEventFolder,
  foldSessionEntries,
  foldUiRequest,
  startPi,
  listSessions as storedSessions,
} from "@cinba/agent";
import {
  type ModelRef,
  type ServerMessage,
  type Session,
  type SessionSummary,
  type ViewAction,
  createSession,
  sameTranscript,
} from "@cinba/contract";

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
  storedEntries: unknown[];
  leafId: string | null;
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
  editMessage(session: LiveSession, entryId: string, text: string): Promise<boolean>;
  denyPendingConfirmations(session: LiveSession): void;
  respondToConfirmation(session: LiveSession, requestId: string, confirmed: boolean): void;
  listModels(session: LiveSession): Promise<ModelRef[]>;
  setModel(session: LiveSession, model: ModelRef): Promise<boolean>;
  rename(session: LiveSession, name: string): Promise<boolean>;
};

export type SessionRegistryOptions = {
  defaultModel: () => ModelRef | undefined;
  onActions: (sessionId: string, actions: ViewAction[]) => void;
  onSnapshot: (sessionId: string, snapshot: ServerMessage) => void;
  hasViewers?: (sessionId: string) => boolean;
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
    if (actions.length === 0) {
      return;
    }
    for (const action of actions) {
      session.ledger.apply(action);
    }
    session.outbox.push(...actions);

    if (session.flushTimer) {
      return;
    }
    session.flushTimer = setTimeout(() => {
      session.flushTimer = undefined;
      const batch = session.outbox;
      session.outbox = [];
      if (batch.length > 0) {
        options.onActions(session.id, batch);
      }
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
    const data = response.data as { entries?: unknown; leafId?: unknown } | undefined;
    const entries = data?.entries;
    if (!Array.isArray(entries)) {
      return;
    }

    session.storedEntries.push(...entries);
    const last = entries.at(-1) as { id?: unknown } | undefined;
    if (typeof last?.id === "string") {
      session.reconciledUpTo = last.id;
      if (data?.leafId === undefined) {
        session.leafId = last.id;
      }
    }
    if (data?.leafId === null || typeof data?.leafId === "string") {
      session.leafId = data.leafId;
    }
  }

  async function reconcile(session: ManagedSession): Promise<void> {
    await absorb(session);
    const truth = createSession();
    const branch = activeBranchEntries(session.storedEntries, session.leafId);
    for (const action of foldSessionEntries(branch)) {
      truth.apply(action);
    }

    const currentEntries = session.ledger.snapshot().entries;
    const hasUnstableMessageId = currentEntries.some(
      (entry) => entry.kind === "message" && !entry.stableId,
    );
    const transcriptMatches = sameTranscript(currentEntries, truth.snapshot().entries);
    if (transcriptMatches && !hasUnstableMessageId) {
      return;
    }
    if (!transcriptMatches) {
      console.warn(`[cinba] transcript drifted in ${session.id}; taking Pi's copy`);
    }
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
    let state;
    try {
      state = await Promise.race([launch.pi.getState(), launch.failed]);
    } catch (error) {
      console.error(
        `[cinba] Pi stopped while starting in ${openOptions.cwd}:`,
        error instanceof Error ? error.message : String(error),
      );
      void launch.pi.close();
      return undefined;
    }
    if (!state) {
      void launch.pi.close();
      return undefined;
    }

    const data = state.data as
      { sessionId?: unknown; model?: { provider?: unknown; id?: unknown } } | undefined;
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
      storedEntries: [],
      leafId: null,
      reconciledUpTo: undefined,
      idleSince: undefined,
      staleCredentials: false,
    };

    launch.pi.onEvent((event) => {
      emitManaged(session, session.fold(event));
      if (event.type === "agent_settled") {
        void reconcile(session).catch((error: unknown) => {
          console.error(
            `[cinba] could not reconcile ${session.id}:`,
            error instanceof Error ? error.message : String(error),
          );
        });
      }
    });
    launch.pi.onUiRequest(async (request) => {
      const action = foldUiRequest(request);
      if (!action) {
        return { cancelled: true };
      }
      if (options.hasViewers && !options.hasViewers(session.id)) {
        return { confirmed: false };
      }
      emitManaged(session, [action]);
      const confirmed = await new Promise<boolean>((resolve) => {
        session.pendingConfirms.set(request.id, resolve);
      });
      return { confirmed };
    });

    await absorb(session);
    const branch = activeBranchEntries(session.storedEntries, session.leafId);
    for (const action of foldSessionEntries(branch)) {
      session.ledger.apply(action);
    }
    live.set(session.id, session);
    return session;
  }

  function stop(id: string): void {
    const session = live.get(id);
    if (!session) {
      return;
    }
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
    }
    for (const resolve of session.pendingConfirms.values()) {
      resolve(false);
    }
    session.pendingConfirms.clear();
    void session.pi.close().catch((error: unknown) => {
      console.error(
        `[cinba] could not close Pi for ${session.id}:`,
        error instanceof Error ? error.message : String(error),
      );
    });
    live.delete(id);
  }

  function findManaged(session: LiveSession): ManagedSession | undefined {
    return live.get(session.id);
  }

  function emit(session: LiveSession, actions: ViewAction[]): void {
    const managed = findManaged(session);
    if (managed) {
      emitManaged(managed, actions);
    }
  }

  function prompt(session: LiveSession, message: string): void {
    const managed = findManaged(session);
    if (!managed) {
      return;
    }
    emitManaged(managed, [{ type: "busy_changed", busy: true }]);
    void managed.pi.prompt(message).catch((error: unknown) => {
      if (findManaged(managed) !== managed) {
        return;
      }
      emitManaged(managed, [
        {
          type: "notice",
          text: `prompt failed: ${error instanceof Error ? error.message : String(error)}`,
        },
        { type: "busy_changed", busy: false },
      ]);
    });
  }

  function abort(session: LiveSession): void {
    const managed = findManaged(session);
    if (!managed) {
      return;
    }
    void managed.pi.abort().catch(() => {});
    emitManaged(managed, [{ type: "notice", text: "aborted" }]);
  }

  async function editMessage(
    session: LiveSession,
    entryId: string,
    text: string,
  ): Promise<boolean> {
    const managed = findManaged(session);
    if (!managed) {
      return false;
    }

    const wasBusy = managed.ledger.snapshot().busy;
    emitManaged(managed, [{ type: "busy_changed", busy: true }]);
    try {
      for (const resolve of managed.pendingConfirms.values()) {
        resolve(false);
      }
      managed.pendingConfirms.clear();
      if (wasBusy) {
        await managed.pi.abort();
      }

      await reconcile(managed);
      const target = activeBranchEntries(managed.storedEntries, managed.leafId).find((raw) => {
        const entry = raw as {
          id?: unknown;
          type?: unknown;
          message?: { role?: unknown };
        };
        return entry.id === entryId && entry.type === "message" && entry.message?.role === "user";
      }) as { parentId?: unknown } | undefined;
      if (!target) {
        throw new Error("the user message is no longer on the active branch");
      }
      const expectedLeaf = typeof target.parentId === "string" ? target.parentId : null;

      const navigate = await managed.pi.prompt(`/cinba-edit-message ${entryId}`);
      if (!navigate.success) {
        throw new Error(String(navigate.error ?? "tree navigation failed"));
      }

      await reconcile(managed);
      if (managed.leafId !== expectedLeaf) {
        throw new Error("the active conversation branch did not move");
      }
      prompt(managed, text);
      return true;
    } catch (error) {
      emitManaged(managed, [
        {
          type: "notice",
          text: `message not edited: ${error instanceof Error ? error.message : String(error)}`,
        },
        { type: "busy_changed", busy: false },
      ]);
      return false;
    }
  }

  function respondToConfirmation(
    session: LiveSession,
    requestId: string,
    confirmed: boolean,
  ): void {
    const managed = findManaged(session);
    const resolve = managed?.pendingConfirms.get(requestId);
    if (!managed || !resolve) {
      return;
    }
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

  function denyPendingConfirmations(session: LiveSession): void {
    const managed = findManaged(session);
    if (!managed) {
      return;
    }
    for (const resolve of managed.pendingConfirms.values()) {
      resolve(false);
    }
    managed.pendingConfirms.clear();
  }

  async function listModels(session: LiveSession): Promise<ModelRef[]> {
    const managed = findManaged(session);
    if (!managed) {
      return [];
    }
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
    if (!managed) {
      return false;
    }
    const response = await managed.pi.setModel(model.provider, model.id);
    if (!response.success) {
      emitManaged(managed, [
        { type: "notice", text: `model not switched: ${String(response.error)}` },
      ]);
      return false;
    }

    managed.model = model;
    emitManaged(managed, [{ type: "model_in_use", provider: model.provider, modelId: model.id }]);
    return true;
  }

  async function rename(session: LiveSession, name: string): Promise<boolean> {
    const managed = findManaged(session);
    if (!managed) {
      return false;
    }
    const response = await managed.pi.setSessionName(name);
    if (!response.success) {
      emitManaged(managed, [{ type: "notice", text: `not renamed: ${String(response.error)}` }]);
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
      for (const id of live.keys()) {
        stop(id);
      }
    },
    emit,
    snapshot,
    prompt,
    abort,
    editMessage,
    denyPendingConfirmations,
    respondToConfirmation,
    listModels,
    setModel,
    rename,
  };
}
