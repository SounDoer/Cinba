import {
  type AdministratorAuthenticated,
  type AdministratorLoginRequest,
  type AdministratorSetupRequest,
  type AdministratorStatus,
  SYNC_ROUTES,
  parseAdministratorAuthenticated,
  parseAdministratorStatus,
} from "@cinba/sync-contract";
import type { ManagementAuthorization } from "./auth.ts";
import { type SyncHttpClient, valueFrom } from "./http.ts";

export class AdministratorSyncClient {
  private readonly http: SyncHttpClient;

  constructor(http: SyncHttpClient) {
    this.http = http;
  }

  async status(signal?: AbortSignal): Promise<AdministratorStatus> {
    return valueFrom(
      await this.http.json({
        path: SYNC_ROUTES.management.authStatus,
        parser: parseAdministratorStatus,
        signal,
        sensitive: true,
      }),
    );
  }

  async setup(
    request: AdministratorSetupRequest,
    signal?: AbortSignal,
  ): Promise<AdministratorAuthenticated> {
    return valueFrom(
      await this.http.json({
        path: SYNC_ROUTES.management.setup,
        method: "POST",
        body: request,
        parser: parseAdministratorAuthenticated,
        signal,
        sensitive: true,
      }),
    );
  }

  async login(
    request: AdministratorLoginRequest,
    signal?: AbortSignal,
  ): Promise<AdministratorAuthenticated> {
    return valueFrom(
      await this.http.json({
        path: SYNC_ROUTES.management.login,
        method: "POST",
        body: request,
        parser: parseAdministratorAuthenticated,
        signal,
        sensitive: true,
      }),
    );
  }

  async logout(
    authorization: ManagementAuthorization,
    signal?: AbortSignal,
  ): Promise<AdministratorStatus> {
    return valueFrom(
      await this.http.json({
        path: SYNC_ROUTES.management.logout,
        method: "POST",
        parser: parseAdministratorStatus,
        headers: {
          "X-Cinba-CSRF": authorization.csrfToken,
          ...(authorization.cookieHeader ? { Cookie: authorization.cookieHeader } : {}),
        },
        signal,
        sensitive: true,
      }),
    );
  }
}
