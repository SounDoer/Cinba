import { randomUUID } from "node:crypto";
import { normalizeRemoteCoreBaseUrl } from "./remote-core-url.ts";

export type LocalCoreProfile = {
  id: "local";
  kind: "local";
  label: string;
  baseUrl: "http://127.0.0.1:4517/";
};

export type RemoteCoreProfile = {
  id: string;
  kind: "remote";
  label: string;
  baseUrl: string;
};

export type CoreProfile = LocalCoreProfile | RemoteCoreProfile;

export type RemoteCoreProfileInput = {
  label: string;
  baseUrl: string;
};

export function createRemoteCoreProfile(
  input: RemoteCoreProfileInput,
  createId: () => string = randomUUID,
): RemoteCoreProfile {
  const label = input.label.trim();
  if (!label) {
    throw new Error("Core profile label is required");
  }
  if (label.length > 80) {
    throw new Error("Core profile label must be 80 characters or fewer");
  }
  const baseUrl = normalizeRemoteCoreBaseUrl(input.baseUrl);
  return {
    id: createId(),
    kind: "remote",
    label,
    baseUrl,
  };
}
