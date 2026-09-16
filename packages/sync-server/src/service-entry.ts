import { defaultSyncStateDirectory, runSyncServer } from "./server.ts";

function integer(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("CINBA_SYNC_PORT must be an integer from 1 to 65535");
  }
  return parsed;
}

const host = process.env.CINBA_SYNC_HOST?.trim() || "127.0.0.1";
const port = integer(process.env.CINBA_SYNC_PORT, 4518);
const publicOrigin = process.env.CINBA_SYNC_PUBLIC_ORIGIN?.trim() || `http://${host}:${port}`;

try {
  await runSyncServer({
    stateDirectory: defaultSyncStateDirectory(),
    host,
    port,
    publicOrigin,
    ...(process.env.CINBA_SYNC_WEB_ROOT ? { webRoot: process.env.CINBA_SYNC_WEB_ROOT } : {}),
  });
} catch (error) {
  console.error(`[sync] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
