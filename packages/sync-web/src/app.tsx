import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AdministratorSyncClient,
  ManagementSyncClient,
  SyncClientError,
  SyncHttpClient,
  managementAuthorization,
} from "@cinba/sync-client";
import type {
  AdministratorStatus,
  BackupMetadata,
  ConnectedCoreList,
  CredentialStatusList,
  ModelCatalog,
  PendingEnrollmentList,
  ServerOverview,
  SettingsHistory,
  SharedSettings,
  SharedSettingsView,
} from "@cinba/sync-contract";
import {
  MANUAL_MODEL_SELECTION,
  type Page,
  SHARED_CREDENTIAL_PROVIDERS,
  consumeCredentialDraft,
  errorMessage,
  initialModelSelection,
  manualModel,
  modelLabel,
} from "./view-model.ts";

type Data = {
  overview: ServerOverview;
  settings: SharedSettingsView;
  credentials: CredentialStatusList;
  cores: ConnectedCoreList;
  enrollments: PendingEnrollmentList;
  models: ModelCatalog;
  history: SettingsHistory;
  backup: BackupMetadata;
};

const pages: Array<{ id: Page; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "settings", label: "Settings" },
  { id: "credentials", label: "Credentials" },
  { id: "cores", label: "Connected Cores" },
  { id: "history", label: "History" },
  { id: "backup", label: "Backup & Restore" },
];

async function fetchManagementData(client: ManagementSyncClient): Promise<Data> {
  const [overview, settings, credentials, cores, enrollments, models, history, backup] =
    await Promise.all([
      client.overview(),
      client.settings(),
      client.credentials(),
      client.cores(),
      client.enrollments(),
      client.models(),
      client.history(),
      client.backupMetadata(),
    ]);
  return { overview, settings, credentials, cores, enrollments, models, history, backup };
}

function isLoopbackLocation(): boolean {
  return (
    location.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)
  );
}

function formatDate(value?: string): string {
  return value ? new Date(value).toLocaleString() : "Never";
}

function AuthScreen({
  status,
  submit,
  busy,
  message,
}: {
  status: AdministratorStatus;
  submit: (fields: { setupCode?: string; password: string }) => Promise<void>;
  busy: boolean;
  message?: string;
}) {
  const [setupCode, setSetupCode] = useState("");
  const [password, setPassword] = useState("");
  const setup = status.state === "setup-required";
  let actionLabel = setup ? "Complete setup" : "Sign in";
  if (busy) {
    actionLabel = "Working…";
  }
  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="auth-title">
        <p className="eyebrow">Cinba Sync</p>
        <h1 id="auth-title">{setup ? "Secure your Sync Server" : "Welcome back"}</h1>
        <p className="muted">
          {setup
            ? "Enter the one-time setup code shown on the server, then choose an administrator password."
            : "Sign in to manage shared settings and connected Cores."}
        </p>
        {message ? (
          <p className="notice error" role="alert">
            {message}
          </p>
        ) : null}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit({ ...(setup ? { setupCode } : {}), password });
          }}
        >
          {setup ? (
            <label>
              Setup code
              <input
                value={setupCode}
                onChange={(event) => setSetupCode(event.target.value)}
                autoComplete="one-time-code"
                required
              />
            </label>
          ) : null}
          <label>
            Administrator password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={setup ? "new-password" : "current-password"}
              minLength={12}
              required
            />
          </label>
          <button className="primary full" disabled={busy}>
            {actionLabel}
          </button>
        </form>
      </section>
    </main>
  );
}

export function App() {
  const http = useMemo(
    () => new SyncHttpClient(location.origin, { allowInsecureLoopback: isLoopbackLocation() }),
    [],
  );
  const administrator = useMemo(() => new AdministratorSyncClient(http), [http]);
  const [auth, setAuth] = useState<AdministratorStatus>();
  const [data, setData] = useState<Data>();
  const [page, setPage] = useState<Page>("overview");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const heading = useRef<HTMLHeadingElement>(null);

  const management = useMemo(
    () =>
      auth?.state === "authenticated" && auth.csrfToken
        ? new ManagementSyncClient(http, managementAuthorization(auth.csrfToken))
        : undefined,
    [auth, http],
  );

  async function refresh(client = management): Promise<void> {
    if (!client) {
      return;
    }
    try {
      setData(await fetchManagementData(client));
      setMessage(undefined);
    } catch (error) {
      if (error instanceof SyncClientError && error.status === 401) {
        setAuth({ version: 1, state: "ready" });
        setData(undefined);
      }
      setMessage(errorMessage(error));
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void administrator
      .status(controller.signal)
      .then((status) => {
        setAuth(status);
        if (status.state === "authenticated" && status.csrfToken) {
          const client = new ManagementSyncClient(http, managementAuthorization(status.csrfToken));
          void fetchManagementData(client)
            .then(setData)
            .catch((error: unknown) => setMessage(errorMessage(error)));
        }
      })
      .catch((error: unknown) => setMessage(errorMessage(error)));
    return () => controller.abort();
  }, [administrator, http]);

  async function authenticate(fields: { setupCode?: string; password: string }): Promise<void> {
    setBusy(true);
    setMessage(undefined);
    try {
      const result =
        fields.setupCode === undefined
          ? await administrator.login({ version: 1, password: fields.password })
          : await administrator.setup({
              version: 1,
              setupCode: fields.setupCode,
              password: fields.password,
            });
      const status = { version: 1, state: "authenticated", csrfToken: result.csrfToken } as const;
      const client = new ManagementSyncClient(http, managementAuthorization(result.csrfToken));
      setAuth(status);
      await refresh(client);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function mutate(
    action: (client: ManagementSyncClient) => Promise<unknown>,
    success: string,
  ): Promise<void> {
    if (!management) {
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      await action(management);
      await refresh(management);
      setMessage(success);
    } catch (error) {
      if (error instanceof SyncClientError && error.status === 401) {
        setAuth({ version: 1, state: "ready" });
        setData(undefined);
      }
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (!auth) {
    return (
      <main className="loading" aria-live="polite">
        {message ?? "Connecting to Cinba Sync…"}
      </main>
    );
  }
  if (auth.state !== "authenticated") {
    return <AuthScreen status={auth} submit={authenticate} busy={busy} message={message} />;
  }
  if (!data) {
    return (
      <main className="loading" aria-live="polite">
        {message ?? "Loading Sync data…"}
      </main>
    );
  }

  const currentLabel = pages.find((item) => item.id === page)?.label ?? "Cinba Sync";
  return (
    <div className="app-shell">
      <aside>
        <div className="brand">
          <span className="mark">C</span>
          <div>
            <strong>Cinba Sync</strong>
            <small>Control plane</small>
          </div>
        </div>
        <nav aria-label="Management">
          {pages.map((item) => (
            <button
              key={item.id}
              className={page === item.id ? "active" : ""}
              aria-current={page === item.id ? "page" : undefined}
              onClick={() => {
                setPage(item.id);
                requestAnimationFrame(() => heading.current?.focus());
              }}
            >
              {item.label}
              {item.id === "cores" && data.enrollments.enrollments.length ? (
                <span className="badge">{data.enrollments.enrollments.length}</span>
              ) : null}
            </button>
          ))}
        </nav>
        <button
          className="quiet signout"
          onClick={() =>
            void administrator.logout(managementAuthorization(auth.csrfToken!)).then(setAuth)
          }
        >
          Sign out
        </button>
      </aside>
      <main className="content">
        <header>
          <div>
            <p className="eyebrow">Management</p>
            <h1 tabIndex={-1} ref={heading}>
              {currentLabel}
            </h1>
          </div>
          <button className="quiet" disabled={busy} onClick={() => void refresh()}>
            Refresh
          </button>
        </header>
        {message ? (
          <output
            className={
              message.includes("expired") ||
              message.includes("changed") ||
              message.includes("unexpected")
                ? "notice error"
                : "notice"
            }
          >
            {message}
          </output>
        ) : null}
        {page === "overview" ? <Overview data={data} /> : null}
        {page === "settings" ? (
          <Settings
            key={data.settings.settingsRevision}
            data={data}
            busy={busy}
            save={(settings) =>
              mutate(
                (client) =>
                  client.updateSettings({
                    version: 1,
                    baseSettingsRevision: data.settings.settingsRevision,
                    settings,
                  }),
                "Settings saved.",
              )
            }
          />
        ) : null}
        {page === "credentials" ? <Credentials data={data} busy={busy} mutate={mutate} /> : null}
        {page === "cores" ? <Cores data={data} busy={busy} mutate={mutate} /> : null}
        {page === "history" ? <History data={data} busy={busy} mutate={mutate} /> : null}
        {page === "backup" ? <Backup data={data} /> : null}
      </main>
    </div>
  );
}

function Overview({ data }: { data: Data }) {
  return (
    <>
      <section className="metric-grid" aria-label="Sync status">
        <article>
          <span>Sync revision</span>
          <strong>{data.overview.syncRevision}</strong>
        </article>
        <article>
          <span>Settings revision</span>
          <strong>{data.overview.settingsRevision}</strong>
        </article>
        <article>
          <span>Connected Cores</span>
          <strong>{data.overview.connectedCoreCount}</strong>
        </article>
        <article>
          <span>Pending approvals</span>
          <strong>{data.overview.pendingEnrollmentCount}</strong>
        </article>
      </section>
      <section className="panel">
        <h2>Server identity</h2>
        <code className="identity">{data.overview.serverId}</code>
      </section>
      <section className="panel">
        <h2>Recent sync errors</h2>
        {data.overview.recentSyncErrors.length ? (
          <ul className="rows">
            {data.overview.recentSyncErrors.map((error) => (
              <li key={error.coreId}>
                <strong>{error.coreName}</strong>
                <code>{error.code}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">No Core has reported a sync error.</p>
        )}
      </section>
    </>
  );
}

function Settings({
  data,
  busy,
  save,
}: {
  data: Data;
  busy: boolean;
  save: (settings: SharedSettings) => Promise<void>;
}) {
  const current = data.settings.settings.defaultModel;
  const [provider, setProvider] = useState(current?.provider ?? "");
  const [modelId, setModelId] = useState(current?.id ?? "");
  const [modelSelection, setModelSelection] = useState(() =>
    initialModelSelection(current, data.models.models),
  );
  const [search, setSearch] = useState(data.settings.settings.webTools.searchPrimary);
  const connected = data.cores.cores.filter((core) => !core.revoked).length;
  const manualModelFields =
    modelSelection === MANUAL_MODEL_SELECTION ? (
      <>
        <div className="two-columns">
          <label>
            Provider
            <input
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
              placeholder="anthropic"
              required
            />
          </label>
          <label>
            Model ID
            <input
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              placeholder="claude-sonnet"
              required
            />
          </label>
        </div>
        <p className="hint">
          Manual IDs are an advanced fallback for models no connected Core has reported.
        </p>
      </>
    ) : null;
  const emptyCatalogHint =
    modelSelection !== MANUAL_MODEL_SELECTION && data.models.models.length === 0 ? (
      <p className="hint">
        Connect a Core first and its supported models will appear in this list.
      </p>
    ) : null;
  function submit(event: FormEvent) {
    event.preventDefault();
    const selected = modelSelection ? manualModel(provider, modelId) : undefined;
    void save({
      version: 1,
      ...(selected ? { defaultModel: selected } : {}),
      webTools: { searchPrimary: search },
    });
  }
  return (
    <form className="panel form-grid" onSubmit={submit}>
      <div className="section-heading">
        <div>
          <h2>Shared settings</h2>
          <p>
            Editing revision {data.settings.settingsRevision}. A concurrent change will stop this
            save.
          </p>
        </div>
        <span className="source">Source · Sync Server</span>
      </div>
      <label>
        Default model
        <select
          value={modelSelection}
          onChange={(event) => {
            const nextSelection = event.target.value;
            setModelSelection(nextSelection);
            if (nextSelection === "") {
              setProvider("");
              setModelId("");
              return;
            }
            if (nextSelection === MANUAL_MODEL_SELECTION) {
              if (modelSelection !== MANUAL_MODEL_SELECTION) {
                setProvider("");
                setModelId("");
              }
              return;
            }
            const [nextProvider, nextId] = nextSelection.split("\0");
            setProvider(nextProvider ?? "");
            setModelId(nextId ?? "");
          }}
        >
          <option value="">No shared default</option>
          {data.models.models.map((candidate) => (
            <option
              key={`${candidate.model.provider}/${candidate.model.id}`}
              value={`${candidate.model.provider}\0${candidate.model.id}`}
            >
              {modelLabel(candidate, connected)}
            </option>
          ))}
          {data.models.models.length === 0 ? (
            <option disabled>Connect a Core to discover models</option>
          ) : null}
          <option value={MANUAL_MODEL_SELECTION}>Enter a model manually…</option>
        </select>
      </label>
      {manualModelFields}
      {emptyCatalogHint}
      <label>
        Primary web search
        <select
          value={search}
          onChange={(event) => setSearch(event.target.value as "auto" | "exa" | "brave")}
        >
          <option value="auto">Automatic</option>
          <option value="exa">Exa</option>
          <option value="brave">Brave</option>
        </select>
      </label>
      <button className="primary" disabled={busy}>
        Save shared settings
      </button>
    </form>
  );
}

function Credentials({
  data,
  busy,
  mutate,
}: {
  data: Data;
  busy: boolean;
  mutate: (
    action: (client: ManagementSyncClient) => Promise<unknown>,
    success: string,
  ) => Promise<void>;
}) {
  const [provider, setProvider] = useState("");
  const [draft, setDraft] = useState("");
  const modelProviders = SHARED_CREDENTIAL_PROVIDERS.filter((item) => item.kind === "model");
  const searchProviders = SHARED_CREDENTIAL_PROVIDERS.filter((item) => item.kind === "search");
  function submit(event: FormEvent) {
    event.preventDefault();
    const credential = consumeCredentialDraft(draft, () => setDraft(""));
    if (!credential || !provider.trim()) {
      return;
    }
    void mutate(
      (client) => client.putCredential(provider.trim(), { version: 1, apiKey: credential }),
      "Credential replaced. Its value is no longer available to the browser.",
    );
  }
  return (
    <>
      <section className="panel">
        <h2>Configured providers</h2>
        {data.credentials.credentials.length ? (
          <ul className="rows">
            {data.credentials.credentials.map((item) => (
              <li key={item.provider}>
                <div>
                  <strong>{item.provider}</strong>
                  <small>Configured · value hidden</small>
                </div>
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      (client) => client.deleteCredential(item.provider),
                      `${item.provider} credential deleted.`,
                    )
                  }
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">No synced credentials are configured.</p>
        )}
      </section>
      <form className="panel form-grid" onSubmit={submit}>
        <h2>Add or replace</h2>
        <label>
          Provider
          <select value={provider} onChange={(event) => setProvider(event.target.value)} required>
            <option value="">Choose a provider</option>
            <optgroup label="Model providers">
              {modelProviders.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.id})
                </option>
              ))}
            </optgroup>
            <optgroup label="Web search">
              {searchProviders.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.id})
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <label>
          API key
          <input
            type="password"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            autoComplete="off"
            required
          />
        </label>
        <p className="hint">
          Only API keys can be shared. OAuth and subscription sign-ins stay on each Core. The key
          field is cleared immediately when submitted, and existing values can never be revealed.
        </p>
        <button className="primary" disabled={busy || !provider}>
          Store credential
        </button>
      </form>
    </>
  );
}

function Cores({
  data,
  busy,
  mutate,
}: {
  data: Data;
  busy: boolean;
  mutate: (
    action: (client: ManagementSyncClient) => Promise<unknown>,
    success: string,
  ) => Promise<void>;
}) {
  return (
    <>
      <section className="panel">
        <h2>Pending approval</h2>
        {data.enrollments.enrollments.length ? (
          <ul className="rows cards">
            {data.enrollments.enrollments.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  <small>
                    {item.platform} · {item.appVersion} · credentials: {item.credentialSource}
                  </small>
                  <small>Expires {formatDate(item.expiresAt)}</small>
                </div>
                <div className="actions">
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void mutate(
                        (client) =>
                          client.decideEnrollment(item.id, { version: 1, decision: "approve" }),
                        `${item.name} approved.`,
                      )
                    }
                  >
                    Approve
                  </button>
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() =>
                      void mutate(
                        (client) =>
                          client.decideEnrollment(item.id, { version: 1, decision: "reject" }),
                        `${item.name} rejected.`,
                      )
                    }
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">No Core is waiting for approval.</p>
        )}
      </section>
      <section className="panel">
        <h2>Connected Cores</h2>
        {data.cores.cores.length ? (
          <ul className="rows cards">
            {data.cores.cores.map((core) => (
              <li key={core.id}>
                <div>
                  <strong>
                    {core.name}
                    {core.revoked ? " · Revoked" : ""}
                  </strong>
                  <small>
                    {core.platform} · {core.appVersion} · credentials: {core.credentialSource}
                  </small>
                  <small>
                    Last seen {formatDate(core.lastSeenAt)} · revision{" "}
                    {core.lastSyncRevision ?? "—"}
                  </small>
                  {core.lastSyncErrorCode ? <code>{core.lastSyncErrorCode}</code> : null}
                </div>
                {!core.revoked ? (
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() =>
                      void mutate((client) => client.revokeCore(core.id), `${core.name} revoked.`)
                    }
                  >
                    Revoke
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">No connected Cores yet.</p>
        )}
      </section>
    </>
  );
}

function History({
  data,
  busy,
  mutate,
}: {
  data: Data;
  busy: boolean;
  mutate: (
    action: (client: ManagementSyncClient) => Promise<unknown>,
    success: string,
  ) => Promise<void>;
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>Settings history</h2>
          <p>Rollback creates a new revision; it does not erase history.</p>
        </div>
        <span className="source">Current · {data.settings.settingsRevision}</span>
      </div>
      <ul className="rows cards">
        {data.history.entries.toReversed().map((entry) => (
          <li key={`${entry.settingsRevision}-${entry.syncRevision}`}>
            <div>
              <strong>Revision {entry.settingsRevision}</strong>
              <small>
                {formatDate(entry.createdAt)} · sync {entry.syncRevision}
              </small>
              <small>
                Model:{" "}
                {entry.settings.defaultModel
                  ? `${entry.settings.defaultModel.provider}/${entry.settings.defaultModel.id}`
                  : "none"}{" "}
                · Search: {entry.settings.webTools.searchPrimary}
              </small>
            </div>
            {entry.settingsRevision !== data.settings.settingsRevision ? (
              <button
                disabled={busy}
                onClick={() =>
                  void mutate(
                    (client) =>
                      client.rollback({
                        version: 1,
                        baseSettingsRevision: data.settings.settingsRevision,
                        targetSettingsRevision: entry.settingsRevision,
                      }),
                    `Rolled back into a new revision from revision ${entry.settingsRevision}.`,
                  )
                }
              >
                Roll back
              </button>
            ) : (
              <span className="current">Current</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Backup({ data }: { data: Data }) {
  return (
    <>
      <section className="panel">
        <h2>Backup status</h2>
        <dl className="details">
          <div>
            <dt>Server</dt>
            <dd>
              <code>{data.backup.serverId}</code>
            </dd>
          </div>
          <div>
            <dt>Latest settings record</dt>
            <dd>{formatDate(data.backup.createdAt)}</dd>
          </div>
          <div>
            <dt>Settings / sync revision</dt>
            <dd>
              {data.backup.settingsRevision} / {data.backup.syncRevision}
            </dd>
          </div>
          <div>
            <dt>Cores / credentials</dt>
            <dd>
              {data.backup.connectedCoreCount} / {data.backup.credentialCount}
            </dd>
          </div>
        </dl>
      </section>
      <section className="panel advisory">
        <h2>Export and restore are intentionally unavailable here</h2>
        <p>
          A backup contains encrypted credentials and still requires sensitive handling. The first
          release exposes verified metadata only. The dedicated backup phase will add export plus
          restore preflight checks for server identity, format version, and writable storage.
          Restore will enter read-only mode before replacement and retain the previous state as a
          recovery path.
        </p>
      </section>
    </>
  );
}
