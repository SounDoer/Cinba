// The few naming decisions both frontends have to make the same way.
//
// Not drawing — each end draws in its own idiom, and should. These are the
// answers to "what do we call this", which is a different question from "how do
// we show it". Left in each frontend they had already drifted: the browser
// showed a project's name where the terminal showed a full path.
//
// Small on purpose. If it ever grows into layout or styling, it has wandered
// into the part that is meant to differ.

import type { SessionSummary } from "./protocol.ts";

/** A working directory's last segment, whichever slash the core's platform uses. */
export function projectName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
}

/**
 * What to call a conversation in a list.
 *
 * A name the user set wins; otherwise the opening line, which Pi already
 * records and which reads better than any title we could invent.
 */
export function sessionTitle(session: SessionSummary): string {
  return session.name || session.firstMessage || "(nothing said yet)";
}

/** The line under the title: which project, how long. */
export function sessionSubtitle(session: SessionSummary): string {
  return `${projectName(session.cwd)} · ${session.messageCount} messages`;
}
