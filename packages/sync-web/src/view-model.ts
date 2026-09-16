import type { ModelCandidate, ModelRef } from "@cinba/sync-contract";
import { SyncClientError } from "@cinba/sync-client";

export type Page = "overview" | "settings" | "credentials" | "cores" | "history" | "backup";

export function errorMessage(error: unknown): string {
  if (error instanceof SyncClientError) {
    if (error.status === 401) {
      return "Your session has expired. Sign in again.";
    }
    if (error.code === "conflict") {
      return "Settings changed on another device. Reload the latest revision before saving.";
    }
    if (error.retryable) {
      return "The Sync Server is temporarily unreachable. Try again.";
    }
  }
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

export function modelLabel(candidate: ModelCandidate, connectedCoreCount: number): string {
  const base = `${candidate.model.provider}/${candidate.model.id}`;
  if (connectedCoreCount === 0) {
    return `${base} · no connected Cores`;
  }
  if (candidate.unsupportedCoreIds.length === 0) {
    return `${base} · all Cores`;
  }
  return `${base} · ${candidate.supportedCoreIds.length}/${connectedCoreCount} Cores`;
}

export function manualModel(provider: string, id: string): ModelRef | undefined {
  const normalizedProvider = provider.trim();
  const normalizedId = id.trim();
  return normalizedProvider && normalizedId
    ? { provider: normalizedProvider, id: normalizedId }
    : undefined;
}

export function consumeCredentialDraft(draft: string, clear: () => void): string | undefined {
  const credential = draft.trim();
  clear();
  return credential || undefined;
}
