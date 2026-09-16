import { useState } from "react";
import type {
  WebSearchCredentialProviderId,
  WebSearchPrimary,
  WebToolsStatus,
} from "@cinba/contract";
import { PickerShell } from "./picker-shell.tsx";

function credentialActionLabel(managedBySync: boolean, available: boolean): string {
  if (managedBySync) {
    return "Managed by Sync";
  }
  return available ? "Replace key" : "Add key";
}

export function WebToolsSettings({
  status,
  error,
  onSetApiKey,
  onClearApiKey,
  onSetPrimary,
  onClose,
}: {
  status: WebToolsStatus | undefined;
  error: string | undefined;
  onSetApiKey: (provider: WebSearchCredentialProviderId, apiKey: string) => boolean;
  onClearApiKey: (provider: WebSearchCredentialProviderId) => boolean;
  onSetPrimary: (primary: WebSearchPrimary) => boolean;
  onClose: () => void;
}) {
  const [adding, setAdding] = useState<WebSearchCredentialProviderId | undefined>();
  const [draft, setDraft] = useState("");
  const [pendingAgainst, setPendingAgainst] = useState<
    { status: WebToolsStatus | undefined } | undefined
  >();
  const pending = pendingAgainst !== undefined && pendingAgainst.status === status && !error;

  function save(provider: WebSearchCredentialProviderId) {
    const apiKey = draft.trim();
    if (apiKey === "") {
      return;
    }
    if (onSetApiKey(provider, apiKey)) {
      setDraft("");
      setAdding(undefined);
      setPendingAgainst({ status });
    }
  }

  function choosePrimary(primary: WebSearchPrimary) {
    if (onSetPrimary(primary)) {
      setPendingAgainst({ status });
    }
  }

  return (
    <PickerShell label="web tools settings" onClose={onClose}>
      <div className="picker-path">
        web_search and web_fetch are always available.{" "}
        {status?.credentialSource === "sync" ? (
          <>Shared API keys are managed by Cinba Sync.</>
        ) : (
          <>API keys are stored by this core and never sent back.</>
        )}
      </div>

      {error ? <div className="picker-item">{error}</div> : null}
      {status === undefined ? <div className="picker-item">Loading...</div> : null}

      {status ? (
        <>
          <div className="picker-item session-row">
            <span className="session-open">
              <span className="session-title">Primary search provider</span>
              <span className="session-meta">
                Effective order: {status.effectiveOrder.map((id) => id).join(" → ")}
              </span>
            </span>
            {(["auto", "exa", "brave"] as const).map((primary) => (
              <button
                key={primary}
                disabled={pending || status.primary === primary || status.settingsSource === "sync"}
                onClick={() => choosePrimary(primary)}
              >
                {status.primary === primary ? "● " : ""}
                {primary}
              </button>
            ))}
          </div>

          {status.settingsSource === "sync" ? (
            <div className="picker-path">
              Primary search is managed by Sync. Use the Sync panel for a Core override.
            </div>
          ) : null}

          <div className="picker-list">
            {status.providers.map((provider) => {
              if (provider.id === "duckduckgo") {
                return (
                  <div className="picker-item session-row" key={provider.id}>
                    <span className="session-open">
                      <span className="session-title">● {provider.name}</span>
                      <span className="session-meta">best-effort fallback · no key required</span>
                    </span>
                  </div>
                );
              }
              const providerId: WebSearchCredentialProviderId = provider.id;

              if (adding === providerId) {
                return (
                  <div className="picker-item session-row" key={provider.id}>
                    <input
                      className="session-rename"
                      type="password"
                      autoComplete="off"
                      autoFocus
                      placeholder={`API key for ${provider.name}`}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          save(providerId);
                        }
                        if (event.key === "Escape") {
                          setDraft("");
                          setAdding(undefined);
                        }
                      }}
                    />
                    <button
                      disabled={pending || draft.trim() === ""}
                      onClick={() => save(providerId)}
                    >
                      Save
                    </button>
                    <button
                      disabled={pending}
                      onClick={() => {
                        setDraft("");
                        setAdding(undefined);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                );
              }

              return (
                <div className="picker-item session-row" key={provider.id}>
                  <span className="session-open">
                    <span className="session-title">
                      {provider.available ? "● " : ""}
                      {provider.name}
                    </span>
                    <span className="session-meta">
                      {provider.source ?? "not configured"}
                      {provider.source === "environment" && provider.hasStoredCredential
                        ? " · stored key also present"
                        : ""}
                    </span>
                  </span>
                  <button
                    disabled={pending || status.credentialSource === "sync"}
                    onClick={() => setAdding(providerId)}
                  >
                    {credentialActionLabel(status.credentialSource === "sync", provider.available)}
                  </button>
                  {provider.hasStoredCredential && status.credentialSource !== "sync" ? (
                    <button
                      className="session-delete"
                      disabled={pending}
                      onClick={() => {
                        if (onClearApiKey(providerId)) {
                          setPendingAgainst({ status });
                        }
                      }}
                    >
                      Remove stored key
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      ) : null}

      <div className="picker-actions">
        <button onClick={onClose}>Close</button>
      </div>
    </PickerShell>
  );
}
