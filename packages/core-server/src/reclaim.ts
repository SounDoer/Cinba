// When to stop an idle conversation's Pi.
//
// Opening a conversation starts a process that costs about 60-85MB and keeps
// costing it whether or not anyone is looking. One person with two or three
// conversations never notices; several people each leaving a few open does.
//
// Stopping one is safe because none of the conversation lives in the process:
// Pi has written it to its session file, so reopening starts a Pi on that file
// and the context comes back. This was deferred when the only user was one
// person, and the reason it was deferred no longer holds.
//
// A pure function so the policy can be tested without a server, a clock, or a
// ten-minute wait.

/** Nothing here is a process handle: it is only what the policy needs to decide. */
export type IdleState = {
  /** Is any client looking at this conversation right now? */
  hasViewers: boolean;
  /** Mid-answer. Stopping here would abandon a turn the user is waiting for. */
  busy: boolean;
  /**
   * Waiting on an allow/deny. Pi is blocked inside the permission gate, and the
   * answer may still be coming from a person who stepped away — killing it
   * would silently drop a decision they were about to make.
   */
  awaitingConfirmation: boolean;
  /** When it last had no viewers, or undefined if it has not been idle. */
  idleSince: number | undefined;
};

/** How long a conversation sits unwatched before its process is stopped. */
export const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export type IdleVerdict = {
  /** What to store back: the moment idleness began, or undefined once someone is watching again. */
  idleSince: number | undefined;
  reclaim: boolean;
};

/**
 * Decide, for one conversation, whether its process should stop now.
 *
 * Being busy or awaiting a confirmation resets the clock rather than merely
 * pausing it: a conversation someone is mid-way through is not idle, and it
 * should get the full quiet period again once it finishes.
 */
export function assessIdle(
  state: IdleState,
  now: number,
  timeoutMs: number = IDLE_TIMEOUT_MS,
): IdleVerdict {
  if (state.hasViewers || state.busy || state.awaitingConfirmation) {
    return { idleSince: undefined, reclaim: false };
  }

  const since = state.idleSince ?? now;
  return { idleSince: since, reclaim: now - since >= timeoutMs };
}
