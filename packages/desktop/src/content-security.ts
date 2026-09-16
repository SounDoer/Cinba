export function remoteContentPreferences() {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    partition: "persist:cinba-core",
  } as const;
}
