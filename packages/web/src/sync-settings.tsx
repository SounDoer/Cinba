import { useCallback, useEffect, useMemo, useState } from "react";
import { CoreSyncControlClient, CoreSyncControlError } from "@cinba/core-client";
import type {
  CoreInstanceOverride,
  CoreSyncSources,
  CoreSyncView,
  WebSearchPrimary,
} from "@cinba/contract";
import { PickerShell } from "./picker-shell.tsx";

const SOURCE_OPTIONS: { value: string; sources: CoreSyncSources; label: string }[] = [
  {
    value: "local/local",
    sources: { settings: "local", credentials: "local" },
    label: "Local settings + local credentials (Dev default)",
  },
  {
    value: "sync/local",
    sources: { settings: "sync", credentials: "local" },
    label: "Shared settings + local credentials",
  },
  {
    value: "sync/sync",
    sources: { settings: "sync", credentials: "sync" },
    label: "Shared settings + shared credentials",
  },
];

function sourceValue(sources: CoreSyncSources): string {
  return `${sources.settings}/${sources.credentials}`;
}

function errorText(error: unknown): string {
  if (error instanceof CoreSyncControlError) {
    return error.message;
  }
  return "The Core could not complete the Sync operation";
}

function modelLabel(model: CoreSyncView["effective"]["defaultModel"]): string {
  return model ? `${model.provider}/${model.id}` : "Pi default";
}

export function SyncSettings({ serverUrl, onClose }: { serverUrl: string; onClose(): void }) {
  const client = useMemo(() => new CoreSyncControlClient(serverUrl), [serverUrl]);
  const [view, setView] = useState<CoreSyncView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [connectUrl, setConnectUrl] = useState("");
  const [connectSources, setConnectSources] = useState<CoreSyncSources>({
    settings: "sync",
    credentials: "local",
  });
  const [provider, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [searchPrimary, setSearchPrimary] = useState<WebSearchPrimary | "shared">("shared");

  const reload = useCallback(async () => {
    try {
      const next = await client.status();
      setView(next);
      setError(undefined);
      setProvider(next.override.defaultModel?.provider ?? "");
      setModelId(next.override.defaultModel?.id ?? "");
      setSearchPrimary(next.override.webTools?.searchPrimary ?? "shared");
    } catch (caught) {
      setError(errorText(caught));
    }
  }, [client]);

  useEffect(() => {
    // Loading remote state is the purpose of this effect.
    // oxlint-disable-next-line react/set-state-in-effect
    void reload();
  }, [reload]);
  useEffect(() => {
    if (view?.state !== "pending") {
      return;
    }
    const timer = setInterval(() => void reload(), 2_000);
    return () => clearInterval(timer);
  }, [reload, view?.state]);

  async function run(operation: () => Promise<unknown>, manualSync = false): Promise<void> {
    setBusy(true);
    setSyncing(manualSync);
    setError(undefined);
    try {
      await operation();
      await reload();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
      setSyncing(false);
    }
  }

  async function saveOverride(): Promise<void> {
    if (Boolean(provider.trim()) !== Boolean(modelId.trim())) {
      setError("Both provider and model ID are required for a model override");
      return;
    }
    const override: CoreInstanceOverride = {
      ...(provider.trim() && modelId.trim()
        ? { defaultModel: { provider: provider.trim(), id: modelId.trim() } }
        : {}),
      ...(searchPrimary === "shared" ? {} : { webTools: { searchPrimary } }),
    };
    await run(() => client.updateOverride(override));
  }

  return (
    <PickerShell label="Sync for this Core" onClose={onClose}>
      {!view ? <p>{error ?? "Loading Sync status..."}</p> : null}
      {view ? (
        <div className="sync-panel">
          <p>
            <strong>{view.state}</strong>
            {view.syncRevision === undefined ? "" : ` · revision ${view.syncRevision}`}
            {view.errorCode ? ` · ${view.errorCode}` : ""}
          </p>
          {view.lastSuccessAt ? <p className="muted">Last synced {view.lastSuccessAt}</p> : null}
          {view.state === "disconnected" ? (
            <>
              <label>
                Sync Server URL
                <input
                  value={connectUrl}
                  onChange={(event) => setConnectUrl(event.target.value)}
                  placeholder="https://sync.example.com"
                />
              </label>
              <SourceSelect value={connectSources} onChange={setConnectSources} disabled={busy} />
              <button
                disabled={busy || connectUrl.trim() === ""}
                onClick={() => void run(() => client.connect(connectUrl.trim(), connectSources))}
              >
                Connect
              </button>
            </>
          ) : null}
          {view.state === "pending" ? (
            <>
              <p>Approval is pending in Sync Web.</p>
              {view.enrollmentExpiresAt ? (
                <p className="muted">Expires {view.enrollmentExpiresAt}</p>
              ) : null}
              <button disabled={busy} onClick={() => void run(() => client.cancelEnrollment())}>
                Cancel enrollment
              </button>
            </>
          ) : null}
          {view.state !== "disconnected" && view.state !== "pending" ? (
            <>
              <SourceSelect
                value={view.sources}
                disabled={busy}
                onChange={(sources) => void run(() => client.updateSources(sources))}
              />
              <div className="sync-actions">
                <button disabled={busy} onClick={() => void run(() => client.syncNow(), true)}>
                  {syncing ? "Syncing..." : "Sync now"}
                </button>
                <button disabled={busy} onClick={() => void run(() => client.disconnect())}>
                  Disconnect
                </button>
              </div>
            </>
          ) : null}

          <hr />
          <p>
            Effective source: <strong>{view.effectiveSettingsSource}</strong>
          </p>
          <p>
            Default model: <strong>{modelLabel(view.effective.defaultModel)}</strong>
            {view.override.defaultModel ? " (Core override)" : " (base setting)"}
          </p>
          <p>
            Web Search: <strong>{view.effective.webTools.searchPrimary}</strong>
            {view.override.webTools?.searchPrimary ? " (Core override)" : " (base setting)"}
          </p>
          {view.shared ? (
            <p className="muted">
              Shared: {modelLabel(view.shared.defaultModel)} · Web Search{" "}
              {view.shared.webTools.searchPrimary}
            </p>
          ) : null}

          <label>
            Override model provider
            <input value={provider} onChange={(event) => setProvider(event.target.value)} />
          </label>
          <label>
            Override model ID
            <input value={modelId} onChange={(event) => setModelId(event.target.value)} />
          </label>
          <label>
            Web Search override
            <select
              value={searchPrimary}
              onChange={(event) =>
                setSearchPrimary(event.target.value as WebSearchPrimary | "shared")
              }
            >
              <option value="shared">Use base setting</option>
              <option value="auto">Auto</option>
              <option value="exa">Exa</option>
              <option value="brave">Brave</option>
            </select>
          </label>
          <div className="sync-actions">
            <button disabled={busy} onClick={() => void saveOverride()}>
              Save Core override
            </button>
            <button disabled={busy} onClick={() => void run(() => client.updateOverride({}))}>
              Reset to shared
            </button>
          </div>
          {view.managementUrl ? (
            <a href={view.managementUrl} target="_blank" rel="noreferrer">
              Open Sync management
            </a>
          ) : null}
          {error ? <p className="settings-error">{error}</p> : null}
        </div>
      ) : null}
    </PickerShell>
  );
}

function SourceSelect({
  value,
  onChange,
  disabled,
}: {
  value: CoreSyncSources;
  onChange(value: CoreSyncSources): void;
  disabled: boolean;
}) {
  return (
    <label>
      Settings and credential source
      <select
        value={sourceValue(value)}
        disabled={disabled}
        onChange={(event) => {
          const selected = SOURCE_OPTIONS.find((option) => option.value === event.target.value);
          if (selected) {
            onChange(selected.sources);
          }
        }}
      >
        {SOURCE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
