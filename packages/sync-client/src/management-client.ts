import {
  type BackupMetadata,
  type ConnectedCoreList,
  type CredentialStatusList,
  type EnrollmentDecisionRequest,
  type PutCredentialRequest,
  type RollbackSettingsRequest,
  SYNC_ROUTES,
  type SettingsHistory,
  type SharedSettingsView,
  type UpdateSharedSettingsRequest,
  parseBackupMetadata,
  parseConnectedCoreList,
  parseCredentialStatusList,
  parseSettingsHistory,
  parseSharedSettingsView,
} from "@cinba/sync-contract";
import type { ManagementAuthorization } from "./auth.ts";
import { type SyncHttpClient, valueFrom } from "./http.ts";

export class ManagementSyncClient {
  private readonly http: SyncHttpClient;
  private readonly authorization: ManagementAuthorization;

  constructor(http: SyncHttpClient, authorization: ManagementAuthorization) {
    this.http = http;
    this.authorization = authorization;
  }

  private headers(): HeadersInit {
    return {
      "X-Cinba-CSRF": this.authorization.csrfToken,
      ...(this.authorization.cookieHeader ? { Cookie: this.authorization.cookieHeader } : {}),
    };
  }

  async settings(signal?: AbortSignal): Promise<SharedSettingsView> {
    return valueFrom(
      await this.http.json({
        path: SYNC_ROUTES.management.settings,
        parser: parseSharedSettingsView,
        headers: this.headers(),
        signal,
      }),
    );
  }

  async updateSettings(
    request: UpdateSharedSettingsRequest,
    signal?: AbortSignal,
  ): Promise<SharedSettingsView> {
    return valueFrom(
      await this.http.json({
        path: SYNC_ROUTES.management.settings,
        method: "PUT",
        body: request,
        parser: parseSharedSettingsView,
        headers: this.headers(),
        signal,
      }),
    );
  }

  async credentials(signal?: AbortSignal): Promise<CredentialStatusList> {
    return valueFrom(
      await this.http.json({
        path: SYNC_ROUTES.management.credentials,
        parser: parseCredentialStatusList,
        headers: this.headers(),
        signal,
        sensitive: true,
      }),
    );
  }

  async putCredential(
    provider: string,
    request: PutCredentialRequest,
    signal?: AbortSignal,
  ): Promise<CredentialStatusList> {
    return valueFrom(
      await this.http.json({
        path: `${SYNC_ROUTES.management.credentials}/${encodeURIComponent(provider)}`,
        method: "PUT",
        body: request,
        parser: parseCredentialStatusList,
        headers: this.headers(),
        signal,
        sensitive: true,
      }),
    );
  }

  async deleteCredential(provider: string, signal?: AbortSignal): Promise<CredentialStatusList> {
    return valueFrom(
      await this.http.json({
        path: `${SYNC_ROUTES.management.credentials}/${encodeURIComponent(provider)}`,
        method: "DELETE",
        parser: parseCredentialStatusList,
        headers: this.headers(),
        signal,
        sensitive: true,
      }),
    );
  }

  async cores(signal?: AbortSignal): Promise<ConnectedCoreList> {
    return valueFrom(
      await this.http.json({
        path: SYNC_ROUTES.management.cores,
        parser: parseConnectedCoreList,
        headers: this.headers(),
        signal,
      }),
    );
  }

  async decideEnrollment(
    enrollmentId: string,
    request: EnrollmentDecisionRequest,
    signal?: AbortSignal,
  ): Promise<ConnectedCoreList> {
    return valueFrom(
      await this.http.json({
        path: `${SYNC_ROUTES.management.enrollments}/${encodeURIComponent(enrollmentId)}`,
        method: "POST",
        body: request,
        parser: parseConnectedCoreList,
        headers: this.headers(),
        signal,
      }),
    );
  }

  async history(signal?: AbortSignal): Promise<SettingsHistory> {
    return valueFrom(
      await this.http.json({
        path: SYNC_ROUTES.management.history,
        parser: parseSettingsHistory,
        headers: this.headers(),
        signal,
      }),
    );
  }

  async rollback(
    request: RollbackSettingsRequest,
    signal?: AbortSignal,
  ): Promise<SharedSettingsView> {
    return valueFrom(
      await this.http.json({
        path: SYNC_ROUTES.management.rollback,
        method: "POST",
        body: request,
        parser: parseSharedSettingsView,
        headers: this.headers(),
        signal,
      }),
    );
  }

  async backupMetadata(signal?: AbortSignal): Promise<BackupMetadata> {
    return valueFrom(
      await this.http.json({
        path: SYNC_ROUTES.management.backupMetadata,
        parser: parseBackupMetadata,
        headers: this.headers(),
        signal,
      }),
    );
  }
}
