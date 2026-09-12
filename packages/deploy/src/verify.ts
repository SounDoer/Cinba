import { CoreClient, type SocketFactory } from "@cinba/core-client";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function validateRevision(value: string): string {
  const revision = value.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error("expectedRevision is not a full Git revision");
  }
  return revision;
}

async function healthMatches(
  url: string,
  expectedRevision: string,
  fetcher: Fetch,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const response = await fetcher(url, { signal });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as Record<string, unknown>;
    return (
      body.status === "ok" &&
      body.revision === expectedRevision &&
      typeof body.safeToRestart === "boolean"
    );
  } catch {
    return false;
  }
}

export async function waitForHealthyRevision(options: {
  url: string;
  expectedRevision: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  requestTimeoutMs?: number;
  fetcher?: Fetch;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}): Promise<void> {
  const expectedRevision = validateRevision(options.expectedRevision);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const deadline = now() + timeoutMs;

  while (true) {
    const remaining = deadline - now();
    const signal = AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, remaining)));
    if (await healthMatches(options.url, expectedRevision, fetcher, signal)) {
      return;
    }
    if (now() >= deadline) {
      throw new Error("Target revision did not become healthy before the deadline");
    }
    await sleep(Math.min(retryDelayMs, deadline - now()));
  }
}

export function verifyCoreConnection(options: {
  url: string;
  timeoutMs?: number;
  socketFactory?: SocketFactory;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let client: CoreClient | undefined;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      client?.close();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const timer = setTimeout(
      () => finish(new Error("Core WebSocket did not identify itself before the deadline")),
      options.timeoutMs ?? 5_000,
    );
    timer.unref();

    client = new CoreClient(
      options.url,
      {
        onCoreIdentity: () => finish(),
        onError: () => finish(new Error("Core WebSocket connection failed")),
      },
      { socketFactory: options.socketFactory, autoReconnect: false },
    );
  });
}
