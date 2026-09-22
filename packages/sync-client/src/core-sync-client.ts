import {
  type CapabilitiesReport,
  type CorePreferencesRequest,
  type CoreReportAccepted,
  type EnrollmentCreated,
  type EnrollmentRequest,
  type EnrollmentStatus,
  SYNC_ROUTES,
  type SyncSnapshot,
  parseCoreReportAccepted,
  parseEnrollmentCreated,
  parseEnrollmentStatus,
  parseSyncSnapshot,
} from "@cinba/sync-contract";
import type { CoreAuthorization, EnrollmentAuthorization } from "./auth.ts";
import { type SyncHttpClient, valueFrom } from "./http.ts";

export type SnapshotResult =
  | { status: "unchanged"; etag?: string }
  | { status: "updated"; snapshot: SyncSnapshot; etag?: string };

export class EnrollmentClient {
  private readonly http: SyncHttpClient;

  constructor(http: SyncHttpClient) {
    this.http = http;
  }

  async create(request: EnrollmentRequest, signal?: AbortSignal): Promise<EnrollmentCreated> {
    return valueFrom(
      await this.http.json({
        path: SYNC_ROUTES.core.enrollments,
        method: "POST",
        body: request,
        parser: parseEnrollmentCreated,
        signal,
        sensitive: true,
      }),
    );
  }

  async status(
    enrollmentId: string,
    authorization: EnrollmentAuthorization,
    signal?: AbortSignal,
  ): Promise<EnrollmentStatus> {
    return valueFrom(
      await this.http.json({
        path: `${SYNC_ROUTES.core.enrollments}/${encodeURIComponent(enrollmentId)}`,
        parser: parseEnrollmentStatus,
        headers: { Authorization: `Enrollment ${authorization.secret}` },
        signal,
        sensitive: true,
      }),
    );
  }
}

export class CoreSyncClient {
  private readonly http: SyncHttpClient;
  private readonly authorization: CoreAuthorization;

  constructor(http: SyncHttpClient, authorization: CoreAuthorization) {
    this.http = http;
    this.authorization = authorization;
  }

  private headers(extra: HeadersInit = {}): HeadersInit {
    return { Authorization: `Bearer ${this.authorization.token}`, ...extra };
  }

  async snapshot(etag?: string, signal?: AbortSignal): Promise<SnapshotResult> {
    const response = await this.http.json({
      path: SYNC_ROUTES.core.snapshot,
      parser: parseSyncSnapshot,
      headers: this.headers(etag ? { "If-None-Match": etag } : {}),
      signal,
      sensitive: true,
      allowNotModified: true,
    });
    if (response.status === "not-modified") {
      return { status: "unchanged", ...(response.etag ? { etag: response.etag } : {}) };
    }
    return {
      status: "updated",
      snapshot: response.value,
      ...(response.etag ? { etag: response.etag } : {}),
    };
  }

  async report(report: CapabilitiesReport, signal?: AbortSignal): Promise<CoreReportAccepted> {
    return valueFrom(
      await this.http.json({
        path: SYNC_ROUTES.core.capabilities,
        method: "PUT",
        body: report,
        parser: parseCoreReportAccepted,
        headers: this.headers(),
        signal,
      }),
    );
  }

  async updateCredentialSource(
    credentialSource: CorePreferencesRequest["credentialSource"],
    signal?: AbortSignal,
  ): Promise<CoreReportAccepted> {
    return valueFrom(
      await this.http.json({
        path: SYNC_ROUTES.core.preferences,
        method: "PUT",
        body: { version: 1, credentialSource } satisfies CorePreferencesRequest,
        parser: parseCoreReportAccepted,
        headers: this.headers(),
        signal,
      }),
    );
  }

  async revoke(signal?: AbortSignal): Promise<CoreReportAccepted> {
    return valueFrom(
      await this.http.json({
        path: SYNC_ROUTES.core.connection,
        method: "DELETE",
        parser: parseCoreReportAccepted,
        headers: this.headers(),
        signal,
      }),
    );
  }
}
