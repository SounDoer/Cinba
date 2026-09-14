// Which model vendors this machine can talk to, and adding one.
//
// The only place in this interface that handles a secret. The rules it follows,
// which are the reason handling one here is affordable at all:
//
//   - the key travels one way. Nothing in the protocol sends one back, so
//     nothing here can display one, including the one just typed
//   - the field is a password field, so it is not readable over a shoulder or
//     in a screen recording
//   - the draft is cleared the moment it is sent
//
// Access control belongs at the Core's trusted network boundary. Once a client
// is allowed to use this Core, local and remote clients have the same controls.

import { useState } from "react";
import type { ProviderStatus } from "@cinba/contract";
import { PickerShell } from "./picker-shell.tsx";

export function ProviderSettings({
  providers,
  onSetApiKey,
  onClearCredential,
  onClose,
}: {
  providers: ProviderStatus[] | undefined;
  onSetApiKey: (providerId: string, apiKey: string) => boolean;
  onClearCredential: (providerId: string) => boolean;
  onClose: () => void;
}) {
  const [adding, setAdding] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [showAll, setShowAll] = useState(false);

  const configured = providers?.filter((provider) => provider.configured) ?? [];
  const rest = providers?.filter((provider) => !provider.configured) ?? [];
  const shown = showAll ? [...configured, ...rest] : configured;

  function save(providerId: string) {
    if (draft.trim() === "") {
      return;
    }
    if (!onSetApiKey(providerId, draft.trim())) {
      return;
    }
    // Cleared immediately: a key has no business sitting in component state
    // after it has been sent.
    setDraft("");
    setAdding(undefined);
  }

  return (
    <PickerShell label="provider settings" onClose={onClose}>
      <div className="picker-path">A key is stored by the core and never sent back here.</div>

      <div className="picker-list">
        {providers === undefined ? <div className="picker-item">Loading...</div> : null}

        {shown.map((provider) => {
          if (adding === provider.id) {
            return (
              <div className="picker-item session-row" key={provider.id}>
                <input
                  className="session-rename"
                  type="password"
                  autoFocus
                  placeholder={`API key for ${provider.name}`}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      save(provider.id);
                    }
                    if (event.key === "Escape") {
                      setDraft("");
                      setAdding(undefined);
                    }
                  }}
                />
                <button disabled={draft.trim() === ""} onClick={() => save(provider.id)}>
                  Save
                </button>
                <button
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
                  {provider.configured ? "● " : ""}
                  {provider.name}
                </span>
                <span className="session-meta">{provider.id}</span>
              </span>
              <button onClick={() => setAdding(provider.id)}>
                {provider.configured ? "Replace key" : "Add key"}
              </button>
              {provider.configured ? (
                <button className="session-delete" onClick={() => onClearCredential(provider.id)}>
                  Forget
                </button>
              ) : null}
            </div>
          );
        })}

        {providers !== undefined && configured.length === 0 && !showAll ? (
          <div className="picker-item">(nothing configured yet)</div>
        ) : null}
      </div>

      <div className="picker-actions">
        <button onClick={onClose}>Close</button>
        <button onClick={() => setShowAll((value) => !value)}>
          {showAll ? "Show configured only" : `Show all ${rest.length + configured.length}`}
        </button>
      </div>
    </PickerShell>
  );
}
