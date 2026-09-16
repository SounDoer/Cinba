import { randomBytes, timingSafeEqual } from "node:crypto";

export const ADMIN_SESSION_COOKIE = "cinba_sync_session";

export type AdministratorSession = {
  id: string;
  csrfToken: string;
  expiresAt: number;
};

export type AdministratorSessionsOptions = {
  lifetimeMs?: number;
  now?: () => number;
};

function secret(): string {
  return randomBytes(32).toString("base64url");
}

function sameSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

export class AdministratorSessions {
  private readonly lifetimeMs: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, AdministratorSession>();

  constructor(options: AdministratorSessionsOptions = {}) {
    this.lifetimeMs = options.lifetimeMs ?? 12 * 60 * 60_000;
    this.now = options.now ?? Date.now;
  }

  create(): AdministratorSession {
    const session = {
      id: secret(),
      csrfToken: secret(),
      expiresAt: this.now() + this.lifetimeMs,
    };
    this.sessions.set(session.id, session);
    return { ...session };
  }

  get(id: string | undefined): AdministratorSession | undefined {
    if (!id) {
      return undefined;
    }
    const session = this.sessions.get(id);
    if (!session) {
      return undefined;
    }
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    return { ...session };
  }

  verifyCsrf(session: AdministratorSession, token: string | undefined): boolean {
    return token !== undefined && sameSecret(session.csrfToken, token);
  }

  remainingSeconds(session: AdministratorSession): number {
    return Math.max(0, Math.floor((session.expiresAt - this.now()) / 1_000));
  }

  revoke(id: string): void {
    this.sessions.delete(id);
  }

  clear(): void {
    this.sessions.clear();
  }
}

export function sessionIdFromCookie(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (name === ADMIN_SESSION_COOKIE) {
      return part.slice(separator + 1).trim() || undefined;
    }
  }
  return undefined;
}

export function createSessionCookie(
  sessionId: string,
  options: { secure: boolean; maximumAgeSeconds: number },
): string {
  return [
    `${ADMIN_SESSION_COOKIE}=${sessionId}`,
    "Path=/api/management",
    "HttpOnly",
    "SameSite=Strict",
    ...(options.secure ? ["Secure"] : []),
    `Max-Age=${options.maximumAgeSeconds}`,
  ].join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  return createSessionCookie("", { secure, maximumAgeSeconds: 0 });
}
