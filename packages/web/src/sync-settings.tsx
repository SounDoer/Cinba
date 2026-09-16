import { useCallback, useEffect, useMemo, useState } from "react";
import { CoreSyncControlClient, CoreSyncControlError } from "@cinba/core-client";
import type {
  CoreInstanceOverride,
  CoreSyncSources,
  CoreSyncView,
  ModelRef,
  WebSearchPrimary,
} from "@cinba/contract";
import { PickerShell } from "./picker-shell.tsx";

const SOURCE_OPTIONS: { value: string; sources: CoreSyncSources; label: string }[] = [
  {
    value: "local/local",
    sources: { settings: "local", credentials: "local" },
    label: "Local settings + local credentials",
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

function hasOverride(override: CoreInstanceOverride): boolean {
  return override.defaultModel !== undefined || override.webTools?.searchPrimary !== undefined;
}

function modelValue(model: ModelRef): string {
  return JSON.stringify([model.provider, model.id]);
}

function effectiveSourceLabel(source: CoreSyncView["effectiveSettingsSource"]): string {
  switch (source) {
    case "sync":
      return "Shared settings";
    case "local-fallback":
      return "Local settings (Sync unavailable)";
    default:
      return "Local settings";
  }
}

function settingOriginLabel(
  customized: boolean,
  effectiveSource: CoreSyncView["effectiveSettingsSource"],
): string {
  if (customized) {
    return "customized for this Core";
  }
  return effectiveSource === "sync" ? "shared setting" : "local setting";
}

export function SyncSettings({
  serverUrl,
  models,
  requestModels,
  onClose,
}: {
  serverUrl: string;
  models: ModelRef[] | undefined;
  requestModels(): boolean;
  onClose(): void;
}) {
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
  const [settingsMode, setSettingsMode] = useState<"shared" | "custom">("shared");

  const reload = useCallback(async () => {
    try {
      const next = await client.status();
      setView(next);
      setError(undefined);
      setProvider(next.override.defaultModel?.provider ?? "");
      setModelId(next.override.defaultModel?.id ?? "");
      setSearchPrimary(next.override.webTools?.searchPrimary ?? "shared");
      setSettingsMode(hasOverride(next.override) ? "custom" : "shared");
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
    requestModels();
  }, [requestModels]);
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
    if (settingsMode === "shared") {
      await run(() => client.updateOverride({}));
      return;
    }
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
    if (!hasOverride(override)) {
      setError("Choose at least one setting to customize for this Core");
      return;
    }
    await run(() => client.updateOverride(override));
  }

  const overrideActive = view ? hasOverride(view.override) : false;
  const selectedModel = provider && modelId ? modelValue({ provider, id: modelId }) : "";
  const selectedModelIsAvailable =
    selectedModel === "" || models?.some((model) => modelValue(model) === selectedModel) === true;

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
            Effective source: <strong>{effectiveSourceLabel(view.effectiveSettingsSource)}</strong>
          </p>
          <p>
            Default model: <strong>{modelLabel(view.effective.defaultModel)}</strong>
            {` (${settingOriginLabel(view.override.defaultModel !== undefined, view.effectiveSettingsSource)})`}
          </p>
          <p>
            Web Search: <strong>{view.effective.webTools.searchPrimary}</strong>
            {` (${settingOriginLabel(view.override.webTools?.searchPrimary !== undefined, view.effectiveSettingsSource)})`}
          </p>
          {view.sources.settings === "sync" && view.shared ? (
            <p className="muted">
              Shared: {modelLabel(view.shared.defaultModel)} · Web Search{" "}
              {view.shared.webTools.searchPrimary}
            </p>
          ) : null}

          <hr />
          <p>
            <strong>Settings for this Core</strong>
          </p>
          {view.sources.settings === "sync" ? (
            <>
              <p className="muted">
                Follow shared settings by default, or keep explicit exceptions only on this Core.
              </p>
              <label>
                Behavior
                <select
                  value={settingsMode}
                  disabled={busy}
                  onChange={(event) => setSettingsMode(event.target.value as "shared" | "custom")}
                >
                  <option value="shared">Follow shared settings</option>
                  <option value="custom">Customize this Core</option>
                </select>
              </label>
              {settingsMode === "custom" ? (
                <>
                  <label>
                    Default model
                    <select
                      value={selectedModel}
                      disabled={busy || models === undefined}
                      onChange={(event) => {
                        if (event.target.value === "") {
                          setProvider("");
                          setModelId("");
                          return;
                        }
                        const [nextProvider, nextModelId] = JSON.parse(event.target.value) as [
                          string,
                          string,
                        ];
                        setProvider(nextProvider);
                        setModelId(nextModelId);
                      }}
                    >
                      <option value="">Use shared default model</option>
                      {!selectedModelIsAvailable ? (
                        <option value={selectedModel}>
                          {provider} / {modelId} (currently unavailable)
                        </option>
                      ) : null}
                      {models?.map((model) => (
                        <option key={modelValue(model)} value={modelValue(model)}>
                          {model.provider} / {model.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Web Search
                    <select
                      value={searchPrimary}
                      disabled={busy}
                      onChange={(event) =>
                        setSearchPrimary(event.target.value as WebSearchPrimary | "shared")
                      }
                    >
                      <option value="shared">Use shared setting</option>
                      <option value="auto">Auto</option>
                      <option value="exa">Exa</option>
                      <option value="brave">Brave</option>
                    </select>
                  </label>
                </>
              ) : null}
              {settingsMode === "custom" || overrideActive ? (
                <div className="sync-actions">
                  <button disabled={busy} onClick={() => void saveOverride()}>
                    {settingsMode === "shared"
                      ? "Follow shared settings again"
                      : "Save settings for this Core"}
                  </button>
                </div>
              ) : (
                <p className="muted">This Core is following shared settings.</p>
              )}
            </>
          ) : (
            <>
              <p className="muted">
                Local settings already belong only to this Core, so no additional override is
                needed.
              </p>
              {overrideActive ? (
                <>
                  <p className="settings-error">
                    A previously saved Core override is still active over Local Settings.
                  </p>
                  <div className="sync-actions">
                    <button
                      disabled={busy}
                      onClick={() => void run(() => client.updateOverride({}))}
                    >
                      Clear Core override
                    </button>
                  </div>
                </>
              ) : null}
            </>
          )}
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
