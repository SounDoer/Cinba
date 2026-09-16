export function remoteContentPreferences(kind: "core" | "sync") {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    partition: kind === "sync" ? "persist:cinba-sync" : "persist:cinba-core",
  } as const;
}
