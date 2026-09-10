// The directory picker.
//
// A browser cannot see local paths, which is a deliberate security limit, so
// the server lists directories and this only draws them. The desktop and web
// builds share it, and that still holds for remote access later.
//
// Picking a directory starts a new conversation in it. Choosing a directory is
// no longer a mode the whole service is in: each conversation carries its own.

import { useEffect, useState } from "react";
import type { CoreClient } from "@cinba/core-client";
import type { DirectoryListing } from "./use-core.ts";

/** Build a subdirectory path, following whichever separator the server returned so the two slashes never mix. */
function childPath(current: string, name: string): string {
  const separator = current.includes("\\") ? "\\" : "/";
  return current.endsWith(separator) ? `${current}${name}` : `${current}${separator}${name}`;
}

export function ProjectPicker({
  client,
  listing,
  startPath,
  onClose,
}: {
  client: CoreClient | undefined;
  listing: DirectoryListing | undefined;
  startPath: string;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState(startPath);

  useEffect(() => {
    client?.listDir(startPath);
  }, [client, startPath]);

  function go(path: string) {
    setCurrent(path);
    client?.listDir(path);
  }

  // Render only when the server's listing is for the current directory, so entering one does not briefly show its parent.
  const shown = listing?.path === current ? listing : undefined;

  return (
    <div className="picker" onClick={onClose}>
      <div className="picker-box" onClick={(event) => event.stopPropagation()}>
        <div className="picker-path">{current}</div>

        <div className="picker-list">
          {shown?.parent ? (
            <button className="picker-item" onClick={() => go(shown.parent!)}>
              .. up
            </button>
          ) : null}
          {shown?.dirs.map((name) => (
            <button className="picker-item" key={name} onClick={() => go(childPath(current, name))}>
              {name}
            </button>
          ))}
          {shown && shown.dirs.length === 0 ? (
            <div className="picker-item">(no subdirectories)</div>
          ) : null}
        </div>

        <div className="picker-actions">
          <button onClick={onClose}>Cancel</button>
          <button
            onClick={() => {
              client?.createSession(current);
              onClose();
            }}
          >
            Start a conversation here
          </button>
        </div>
      </div>
    </div>
  );
}
