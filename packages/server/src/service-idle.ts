export const SERVICE_IDLE_TIMEOUT_MS = 10 * 60_000;

export type CoreLifetime = "persistent" | "on-demand";

export type ServiceIdleState = {
  clientCount: number;
  safeToStop: boolean;
  idleSince: number | undefined;
};

export type ServiceIdleVerdict = {
  idleSince: number | undefined;
  stop: boolean;
};

export function readCoreLifetime(value: string | undefined): CoreLifetime {
  if (value === undefined || value === "persistent") {
    return "persistent";
  }
  if (value === "on-demand") {
    return value;
  }
  throw new Error(`Unsupported CINBA_CORE_LIFETIME: ${value}`);
}

/** Decide whether an on-demand Core has been safely unused for long enough to exit. */
export function assessServiceIdle(
  lifetime: CoreLifetime,
  state: ServiceIdleState,
  now: number,
  timeoutMs = SERVICE_IDLE_TIMEOUT_MS,
): ServiceIdleVerdict {
  if (lifetime === "persistent" || state.clientCount > 0) {
    return { idleSince: undefined, stop: false };
  }

  const idleSince = state.idleSince ?? now;
  return {
    idleSince,
    stop: state.safeToStop && now - idleSince >= timeoutMs,
  };
}
