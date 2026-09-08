// The model picker.
//
// The list comes from the core rather than from a table written here: Pi
// returns only the models this machine has credentials for, so a hardcoded list
// would both go stale and offer entries that fail the moment they are picked.

import { useEffect } from "react";
import type { ModelRef, RemoteSession } from "@cinba/core-client";

export function ModelPicker({
  remote,
  models,
  current,
  onClose,
}: {
  remote: RemoteSession | undefined;
  models: ModelRef[] | undefined;
  current: ModelRef | undefined;
  onClose: () => void;
}) {
  useEffect(() => {
    remote?.listModels();
  }, [remote]);

  return (
    <div className="picker" onClick={onClose}>
      <div className="picker-box" onClick={(event) => event.stopPropagation()}>
        <div className="picker-path">
          Switching keeps the conversation: the next reply comes from the new model with the same
          context.
        </div>

        <div className="picker-list">
          {models === undefined ? <div className="picker-item">Loading...</div> : null}
          {models?.map((model) => {
            const active = model.provider === current?.provider && model.id === current?.id;
            return (
              <button
                className="picker-item"
                key={`${model.provider}/${model.id}`}
                onClick={() => {
                  if (!active) remote?.setModel(model.provider, model.id);
                  onClose();
                }}
              >
                {active ? "● " : "  "}
                {model.provider} / {model.id}
              </button>
            );
          })}
          {models?.length === 0 ? (
            <div className="picker-item">
              (no models available — check the credentials in ~/.pi/agent/auth.json)
            </div>
          ) : null}
        </div>

        <div className="picker-actions">
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
