// Reads Pi's append-only session files without starting a Pi process.

import { SessionManager } from "@earendil-works/pi-coding-agent";

export type StoredSession = {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  messageCount: number;
  firstMessage: string;
  modified: Date;
};

/** List stored conversations newest first, optionally restricted to one working directory. */
export async function listSessions(cwd?: string): Promise<StoredSession[]> {
  const infos = cwd === undefined ? await SessionManager.listAll() : await SessionManager.list(cwd);
  return infos.map((info) => ({
    id: info.id,
    path: info.path,
    cwd: info.cwd,
    name: info.name,
    messageCount: info.messageCount,
    firstMessage: info.firstMessage,
    modified: info.modified,
  }));
}

/** Find one stored conversation, or undefined if its session file is gone. */
export async function findSession(id: string): Promise<StoredSession | undefined> {
  const sessions = await listSessions();
  return sessions.find((session) => session.id === id);
}
