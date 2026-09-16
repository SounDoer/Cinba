import type { AdministratorAuthenticated, AdministratorStatus } from "@cinba/sync-contract";
import { AttemptLimiter } from "../security/rate-limiter.ts";
import {
  AdministratorSessions,
  clearSessionCookie,
  createSessionCookie,
  sessionIdFromCookie,
} from "../security/sessions.ts";
import type { SyncStore } from "../store/sync-store.ts";

export type CookieMode = "secure" | "loopback-development";

export type RequestSecurity = {
  origin?: string;
  cookie?: string;
  csrfToken?: string;
  clientKey: string;
};

export type AuthenticationSuccess = {
  ok: true;
  body: AdministratorAuthenticated;
  setCookie: string;
};

export type AuthenticationFailure = {
  ok: false;
  status: 400 | 401 | 403 | 409 | 429;
  code: "invalid_request" | "unauthorized" | "forbidden" | "conflict" | "rate_limited";
};

export type AuthenticationResult = AuthenticationSuccess | AuthenticationFailure;

function expectedOrigin(input: string, mode: CookieMode): { origin: string; secure: boolean } {
  const url = new URL(input);
  if (url.origin !== input && `${url.origin}/` !== input) {
    throw new Error("Administrator origin must be a root origin");
  }
  if (mode === "secure") {
    if (url.protocol !== "https:") {
      throw new Error("Secure administrator mode requires an HTTPS origin");
    }
    return { origin: url.origin, secure: true };
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "http:" ||
    (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]")
  ) {
    throw new Error("Loopback development mode requires a loopback HTTP origin");
  }
  return { origin: url.origin, secure: false };
}

export class AdministratorAuthService {
  private readonly store: SyncStore;
  private readonly origin: string;
  private readonly secureCookie: boolean;
  private readonly sessions: AdministratorSessions;
  private readonly attempts: AttemptLimiter;

  constructor(options: {
    store: SyncStore;
    origin: string;
    cookieMode?: CookieMode;
    sessions?: AdministratorSessions;
    attempts?: AttemptLimiter;
  }) {
    this.store = options.store;
    const origin = expectedOrigin(options.origin, options.cookieMode ?? "secure");
    this.origin = origin.origin;
    this.secureCookie = origin.secure;
    this.sessions = options.sessions ?? new AdministratorSessions();
    this.attempts = options.attempts ?? new AttemptLimiter();
  }

  private sameOrigin(origin: string | undefined): boolean {
    if (!origin) {
      return false;
    }
    try {
      return new URL(origin).origin === this.origin && new URL(origin).origin === origin;
    } catch {
      return false;
    }
  }

  private success(): AuthenticationSuccess {
    const session = this.sessions.create();
    return {
      ok: true,
      body: {
        version: 1,
        state: "authenticated",
        csrfToken: session.csrfToken,
        expiresAt: new Date(session.expiresAt).toISOString(),
      },
      setCookie: createSessionCookie(session.id, {
        secure: this.secureCookie,
        maximumAgeSeconds: this.sessions.remainingSeconds(session),
      }),
    };
  }

  status(cookie: string | undefined): AdministratorStatus {
    const session = this.sessions.get(sessionIdFromCookie(cookie));
    if (session) {
      return { version: 1, state: "authenticated", csrfToken: session.csrfToken };
    }
    return { version: 1, state: this.store.authenticationState() };
  }

  async setup(
    setupCode: string,
    password: string,
    security: RequestSecurity,
  ): Promise<AuthenticationResult> {
    if (!this.sameOrigin(security.origin)) {
      return { ok: false, status: 403, code: "forbidden" };
    }
    if (this.store.authenticationState() !== "setup-required") {
      return { ok: false, status: 409, code: "conflict" };
    }
    if (password.length < 12) {
      return { ok: false, status: 400, code: "invalid_request" };
    }
    if (this.attempts.blocked(security.clientKey)) {
      return { ok: false, status: 429, code: "rate_limited" };
    }
    if (!(await this.store.completeAdministratorSetup(setupCode, password))) {
      this.attempts.recordFailure(security.clientKey);
      return { ok: false, status: 401, code: "unauthorized" };
    }
    this.attempts.clear(security.clientKey);
    return this.success();
  }

  login(password: string, security: RequestSecurity): AuthenticationResult {
    if (!this.sameOrigin(security.origin)) {
      return { ok: false, status: 403, code: "forbidden" };
    }
    if (this.store.authenticationState() !== "ready") {
      return { ok: false, status: 409, code: "conflict" };
    }
    if (this.attempts.blocked(security.clientKey)) {
      return { ok: false, status: 429, code: "rate_limited" };
    }
    if (!this.store.verifyAdministratorPassword(password)) {
      this.attempts.recordFailure(security.clientKey);
      return { ok: false, status: 401, code: "unauthorized" };
    }
    this.attempts.clear(security.clientKey);
    return this.success();
  }

  authorizeWrite(
    security: RequestSecurity,
  ): AuthenticationFailure | { ok: true; sessionId: string } {
    if (!this.sameOrigin(security.origin)) {
      return { ok: false, status: 403, code: "forbidden" };
    }
    const sessionId = sessionIdFromCookie(security.cookie);
    const session = this.sessions.get(sessionId);
    if (!session || !sessionId) {
      return { ok: false, status: 401, code: "unauthorized" };
    }
    if (!this.sessions.verifyCsrf(session, security.csrfToken)) {
      return { ok: false, status: 403, code: "forbidden" };
    }
    return { ok: true, sessionId };
  }

  authorizeRead(
    cookie: string | undefined,
  ): AuthenticationFailure | { ok: true; sessionId: string } {
    const sessionId = sessionIdFromCookie(cookie);
    if (!sessionId || !this.sessions.get(sessionId)) {
      return { ok: false, status: 401, code: "unauthorized" };
    }
    return { ok: true, sessionId };
  }

  logout(security: RequestSecurity): AuthenticationFailure | { ok: true; setCookie: string } {
    const authorization = this.authorizeWrite(security);
    if (!authorization.ok) {
      return authorization;
    }
    this.sessions.revoke(authorization.sessionId);
    return { ok: true, setCookie: clearSessionCookie(this.secureCookie) };
  }

  async resetPasswordLocally(): Promise<string> {
    const setupCode = await this.store.resetAdministrator();
    this.sessions.clear();
    this.attempts.clearAll();
    return setupCode;
  }
}
