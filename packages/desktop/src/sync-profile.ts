export type SyncProfile = {
  id: "sync";
  kind: "sync";
  label: "Cinba Sync";
  baseUrl: string;
};

export function createSyncProfile(baseUrl: string): SyncProfile {
  const url = new URL(baseUrl);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error("Sync Server URL must be an HTTPS origin root");
  }
  return { id: "sync", kind: "sync", label: "Cinba Sync", baseUrl: `${url.origin}/` };
}
